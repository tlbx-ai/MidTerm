import { createLogger } from '../logging';
import { onTabActivated, onTabDeactivated } from '../sessionTabs';
import { showDevErrorDialog } from '../../utils/devErrorDialog';
import { renderMarkdown } from '../../utils/markdown';
import {
  attachSessionLens,
  getLensSnapshot,
  getLensEvents,
  approveLensRequest,
  declineLensRequest,
  resolveLensUserInput,
  openLensEventStream,
  type LensPulseEvent,
  type LensPulseRequestSummary,
  type LensPulseSnapshotResponse,
} from '../../api/client';

const log = createLogger('agentView');
const viewStates = new Map<string, SessionLensViewState>();
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;
const TRANSCRIPT_OVERSCAN_PX = 800;
const TRANSCRIPT_VIRTUALIZE_AFTER = 80;

interface SessionLensViewState {
  panel: HTMLDivElement;
  snapshot: LensPulseSnapshotResponse | null;
  events: LensPulseEvent[];
  transcriptViewport: HTMLDivElement | null;
  transcriptEntries: LensTranscriptEntry[];
  disconnectStream: (() => void) | null;
  streamConnected: boolean;
  refreshScheduled: number | null;
  refreshInFlight: boolean;
  requestBusyIds: Set<string>;
  transcriptAutoScrollPinned: boolean;
  transcriptRenderScheduled: number | null;
  activationState:
    | 'idle'
    | 'opening'
    | 'attaching'
    | 'waiting-snapshot'
    | 'loading-events'
    | 'connecting-stream'
    | 'ready'
    | 'failed';
  activationDetail: string;
  activationTrace: LensActivationTraceEntry[];
  activationError: string | null;
}

interface LensActivationTraceEntry {
  tone: TranscriptTone;
  meta: string;
  summary: string;
  detail: string;
}

type TranscriptKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'request'
  | 'plan'
  | 'diff'
  | 'system'
  | 'notice';
type TranscriptTone = 'info' | 'positive' | 'warning' | 'attention';

export interface LensTranscriptEntry {
  id: string;
  order: number;
  kind: TranscriptKind;
  tone: TranscriptTone;
  label: string;
  title: string;
  body: string;
  meta: string;
  requestId?: string;
}

export interface TranscriptVirtualWindow {
  start: number;
  end: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
}

export function initAgentView(): void {
  onTabActivated('agent', (sessionId, panel) => {
    ensureAgentViewSkeleton(sessionId, panel);
    const state = getOrCreateViewState(sessionId, panel);
    state.panel = panel;
    bindTranscriptViewport(sessionId, state);
    void activateAgentView(sessionId);
  });

  onTabDeactivated('agent', (sessionId) => {
    closeLensStream(sessionId);
  });

  log.info(() => 'Agent view initialized');
}

export function destroyAgentView(sessionId: string): void {
  closeLensStream(sessionId);
  const state = viewStates.get(sessionId);
  if (state && state.refreshScheduled !== null) {
    window.clearTimeout(state.refreshScheduled);
  }
  if (state && state.transcriptRenderScheduled !== null) {
    window.cancelAnimationFrame(state.transcriptRenderScheduled);
  }

  viewStates.delete(sessionId);
}

async function activateAgentView(sessionId: string): Promise<void> {
  const state = viewStates.get(sessionId);
  if (!state) {
    return;
  }

  state.snapshot = null;
  state.events = [];
  state.streamConnected = false;
  state.activationTrace = [];
  state.activationError = null;

  setActivationState(
    state,
    'opening',
    'Lens pane opened. Preparing transcript runtime attach.',
    'Lens pane opened.',
    'MidTerm is switching from the terminal surface to the Lens transcript for this session.',
  );
  setActivationState(
    state,
    'attaching',
    'Requesting Lens runtime attach.',
    'Attaching Lens runtime.',
    'Starting or reconnecting the backend-owned Lens runtime for this session.',
  );
  renderCurrentAgentView(sessionId);

  try {
    await attachSessionLens(sessionId);
    setActivationState(
      state,
      'waiting-snapshot',
      'Lens runtime accepted the attach request.',
      'Lens runtime attached.',
      'Waiting for the first canonical Lens snapshot from MidTerm.',
    );
    renderCurrentAgentView(sessionId);

    const snapshot = await waitForInitialLensSnapshot(sessionId, state);

    setActivationState(
      state,
      'loading-events',
      'Lens snapshot is ready. Loading recent transcript events.',
      'Lens snapshot ready.',
      'Loading the canonical Lens event backlog for this session.',
    );
    renderCurrentAgentView(sessionId);

    const eventFeed = await getLensEvents(sessionId);
    state.snapshot = snapshot;
    state.events = eventFeed.events.slice(-200);
    state.streamConnected = false;

    setActivationState(
      state,
      'connecting-stream',
      'Lens data is loaded. Connecting the live stream.',
      'Lens event backlog loaded.',
      'Opening the live Lens event stream so the transcript updates in real time.',
    );
    renderCurrentAgentView(sessionId);
    openLiveLensStream(sessionId, snapshot.latestSequence);
  } catch (error) {
    log.warn(() => `Failed to activate Lens for ${sessionId}: ${String(error)}`);
    state.activationError = describeError(error);
    setActivationState(
      state,
      'failed',
      'Lens startup failed before the first stable snapshot became available.',
      'Lens startup failed.',
      state.activationError,
      'attention',
    );
    showDevErrorDialog({
      title: 'Lens failed to open',
      context: `Lens activation failed for session ${sessionId}`,
      error,
    });
    renderCurrentAgentView(sessionId);
  }
}

function getOrCreateViewState(sessionId: string, panel: HTMLDivElement): SessionLensViewState {
  const existing = viewStates.get(sessionId);
  if (existing) {
    return existing;
  }

  const created: SessionLensViewState = {
    panel,
    snapshot: null,
    events: [],
    transcriptViewport: null,
    transcriptEntries: [],
    disconnectStream: null,
    streamConnected: false,
    refreshScheduled: null,
    refreshInFlight: false,
    requestBusyIds: new Set<string>(),
    transcriptAutoScrollPinned: true,
    transcriptRenderScheduled: null,
    activationState: 'idle',
    activationDetail: '',
    activationTrace: [],
    activationError: null,
  };

  viewStates.set(sessionId, created);
  return created;
}

function ensureAgentViewSkeleton(_sessionId: string, panel: HTMLDivElement): void {
  if (panel.dataset.agentViewReady === 'true') {
    return;
  }

  panel.dataset.agentViewReady = 'true';
  panel.classList.add('agent-view-panel');
  panel.innerHTML = `
    <section class="agent-view">
      <section class="agent-transcript-card">
        <div class="agent-transcript" data-agent-field="transcript"></div>
      </section>
    </section>
  `;
}

function bindTranscriptViewport(sessionId: string, state: SessionLensViewState): void {
  const viewport = state.panel.querySelector<HTMLDivElement>('[data-agent-field="transcript"]');
  state.transcriptViewport = viewport;
  if (!viewport || viewport.dataset.lensScrollBound === 'true') {
    return;
  }

  viewport.dataset.lensScrollBound = 'true';
  viewport.addEventListener('scroll', () => {
    const current = viewStates.get(sessionId);
    const currentViewport = current?.transcriptViewport;
    if (!current || !currentViewport) {
      return;
    }

    current.transcriptAutoScrollPinned = isScrollContainerNearBottom({
      scrollTop: currentViewport.scrollTop,
      clientHeight: currentViewport.clientHeight,
      scrollHeight: currentViewport.scrollHeight,
    });

    if (current.transcriptEntries.length > TRANSCRIPT_VIRTUALIZE_AFTER) {
      scheduleTranscriptRender(sessionId);
    }
  });
}

function scheduleTranscriptRender(sessionId: string): void {
  const state = viewStates.get(sessionId);
  if (!state || state.transcriptRenderScheduled !== null) {
    return;
  }

  state.transcriptRenderScheduled = window.requestAnimationFrame(() => {
    const current = viewStates.get(sessionId);
    if (!current) {
      return;
    }

    current.transcriptRenderScheduled = null;
    renderCurrentAgentView(sessionId);
  });
}

function openLiveLensStream(sessionId: string, afterSequence: number): void {
  const state = viewStates.get(sessionId);
  if (!state) {
    return;
  }

  closeLensStream(sessionId);
  state.disconnectStream = openLensEventStream(sessionId, afterSequence, {
    onOpen: () => {
      const current = viewStates.get(sessionId);
      if (!current) {
        return;
      }

      current.streamConnected = true;
      setActivationState(
        current,
        'ready',
        'Lens live stream connected.',
        'Live Lens stream connected.',
        'Realtime canonical Lens events are now flowing into the transcript.',
        'positive',
      );
      renderCurrentAgentView(sessionId);
    },
    onEvent: (lensEvent) => {
      const current = viewStates.get(sessionId);
      if (!current) {
        return;
      }

      current.events = [...current.events, lensEvent].slice(-200);
      renderCurrentAgentView(sessionId);
      scheduleSnapshotRefresh(sessionId);
    },
    onError: () => {
      const current = viewStates.get(sessionId);
      if (!current) {
        return;
      }

      current.streamConnected = false;
      renderCurrentAgentView(sessionId);
    },
  });
}

function closeLensStream(sessionId: string): void {
  const state = viewStates.get(sessionId);
  if (!state) {
    return;
  }

  state.disconnectStream?.();
  state.disconnectStream = null;
  state.streamConnected = false;
}

function scheduleSnapshotRefresh(sessionId: string): void {
  const state = viewStates.get(sessionId);
  if (!state || state.refreshScheduled !== null) {
    return;
  }

  state.refreshScheduled = window.setTimeout(() => {
    state.refreshScheduled = null;
    void refreshLensSnapshot(sessionId);
  }, 120);
}

async function refreshLensSnapshot(sessionId: string): Promise<void> {
  const state = viewStates.get(sessionId);
  if (!state || state.refreshInFlight) {
    return;
  }

  state.refreshInFlight = true;
  try {
    state.snapshot = await getLensSnapshot(sessionId);
    if (state.activationState !== 'ready') {
      setActivationState(
        state,
        'ready',
        'Lens snapshot refreshed.',
        'Lens snapshot refreshed.',
        'The Lens read model is available and the transcript is rendering live data.',
        'positive',
      );
    }
    renderCurrentAgentView(sessionId);
  } catch (error) {
    log.warn(() => `Failed to refresh Lens snapshot for ${sessionId}: ${String(error)}`);
    state.activationError = describeError(error);
    setActivationState(
      state,
      'failed',
      'Lens snapshot refresh failed.',
      'Lens refresh failed.',
      state.activationError,
      'attention',
    );
    showDevErrorDialog({
      title: 'Lens refresh failed',
      context: `Lens snapshot refresh failed for session ${sessionId}`,
      error,
    });
    renderCurrentAgentView(sessionId);
  } finally {
    state.refreshInFlight = false;
  }
}

function renderCurrentAgentView(sessionId: string): void {
  const state = viewStates.get(sessionId);
  if (!state) {
    return;
  }

  if (!state.snapshot) {
    renderActivationView(state.panel, state);
    return;
  }

  renderAgentView(state.panel, state.snapshot, state.events, state.streamConnected, state);
}

function renderAgentView(
  panel: HTMLDivElement,
  snapshot: LensPulseSnapshotResponse,
  events: LensPulseEvent[],
  streamConnected: boolean,
  state: SessionLensViewState,
): void {
  panel.dataset.agentTurnId = snapshot.currentTurn.turnId || '';
  const transcriptEntries = buildLensTranscriptEntries(snapshot, events);
  renderTranscript(
    panel,
    withInlineLensStatus(snapshot, transcriptEntries, streamConnected),
    snapshot.sessionId,
    state.requestBusyIds,
  );
}

function renderActivationView(panel: HTMLDivElement, state: SessionLensViewState): void {
  panel.dataset.agentTurnId = '';
  renderTranscript(panel, buildActivationTranscriptEntries(state), '', new Set<string>());
}

function renderTranscript(
  panel: HTMLDivElement,
  entries: LensTranscriptEntry[],
  sessionId: string,
  busyRequestIds: ReadonlySet<string>,
): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="transcript"]');
  if (!container) {
    return;
  }

  const state = viewStates.get(sessionId);
  if (state) {
    state.transcriptViewport = container as HTMLDivElement;
    state.transcriptEntries = entries;
  }

  if (entries.length === 0) {
    renderEmptyContainer(container, 'No transcript entries yet.');
    return;
  }

  const virtualWindow = computeTranscriptVirtualWindow(
    entries,
    (container as HTMLDivElement).scrollTop,
    (container as HTMLDivElement).clientHeight,
  );
  const visibleEntries = entries.slice(virtualWindow.start, virtualWindow.end);
  const fragment = document.createDocumentFragment();
  if (virtualWindow.topSpacerPx > 0) {
    fragment.appendChild(createTranscriptSpacer(virtualWindow.topSpacerPx));
  }
  for (const entry of visibleEntries) {
    fragment.appendChild(createTranscriptEntry(entry, sessionId, busyRequestIds));
  }
  if (virtualWindow.bottomSpacerPx > 0) {
    fragment.appendChild(createTranscriptSpacer(virtualWindow.bottomSpacerPx));
  }

  container.replaceChildren(fragment);

  if (state?.transcriptAutoScrollPinned) {
    window.requestAnimationFrame(() => {
      const viewport = state.transcriptViewport;
      if (!viewport) {
        return;
      }
      viewport.scrollTop = viewport.scrollHeight;
    });
  }
}

export function buildLensTranscriptEntries(
  snapshot: LensPulseSnapshotResponse,
  events: LensPulseEvent[],
): LensTranscriptEntry[] {
  const entries: LensTranscriptEntry[] = [];
  const byKey = new Map<string, LensTranscriptEntry>();
  const requestSummaryById = new Map(
    snapshot.requests.map((request) => [request.requestId, request]),
  );
  const sortedEvents = [...events].sort((left, right) => left.sequence - right.sequence);

  const ensureEntry = (
    key: string,
    create: () => LensTranscriptEntry,
    orderOverride?: number,
  ): LensTranscriptEntry => {
    const existing = byKey.get(key);
    if (existing) {
      if (typeof orderOverride === 'number') {
        existing.order = Math.max(existing.order, orderOverride);
      }
      return existing;
    }

    const entry = create();
    if (typeof orderOverride === 'number') {
      entry.order = orderOverride;
    }
    byKey.set(key, entry);
    entries.push(entry);
    return entry;
  };

  for (const lensEvent of sortedEvents) {
    const order = lensEvent.sequence;

    if (lensEvent.item && lensEvent.itemId) {
      const itemKind = transcriptKindFromItem(lensEvent.item.itemType);
      const itemKey =
        itemKind === 'tool'
          ? `tool:${lensEvent.itemId || lensEvent.turnId || lensEvent.sequence}`
          : `${itemKind}:${lensEvent.itemId}`;
      const itemEntry = ensureEntry(itemKey, () => ({
        id: itemKey,
        order,
        kind: itemKind,
        tone: toneFromState(lensEvent.item?.status),
        label: transcriptLabel(itemKind),
        title:
          itemKind === 'tool'
            ? compactToolTitle(lensEvent.item?.title || lensEvent.item?.itemType || 'tool')
            : transcriptLabel(itemKind),
        body: resolveTranscriptItemBody(itemKind, lensEvent.item?.detail, lensEvent.item?.title),
        meta: `${prettify(lensEvent.item?.status || 'updated')} • ${formatAbsoluteTime(lensEvent.createdAt)}`,
      }));
      itemEntry.kind = itemKind;
      itemEntry.tone = toneFromState(lensEvent.item.status);
      itemEntry.label = transcriptLabel(itemKind);
      itemEntry.title =
        itemKind === 'tool'
          ? compactToolTitle(lensEvent.item.title || lensEvent.item.itemType || 'tool')
          : transcriptLabel(itemKind);
      const itemBody = resolveTranscriptItemBody(
        itemKind,
        lensEvent.item.detail,
        lensEvent.item.title,
      );
      if (itemBody && !itemEntry.body.includes(itemBody)) {
        itemEntry.body = appendTranscriptChunk(itemEntry.body, itemBody);
      }
      itemEntry.meta = `${prettify(lensEvent.item.status)} • ${formatAbsoluteTime(lensEvent.createdAt)}`;
      itemEntry.order = order;
    }

    if (lensEvent.contentDelta) {
      const streamKind = lensEvent.contentDelta.streamKind;
      const transcriptKind = transcriptKindFromStream(streamKind);
      if (!transcriptKind) {
        continue;
      }
      const key =
        transcriptKind === 'tool'
          ? `tool:${lensEvent.itemId || lensEvent.turnId || lensEvent.sequence}`
          : `${transcriptKind}:${lensEvent.itemId || lensEvent.turnId || lensEvent.sequence}`;
      const contentEntry = ensureEntry(key, () => ({
        id: key,
        order,
        kind: transcriptKind,
        tone: transcriptKind === 'assistant' ? 'info' : 'warning',
        label: transcriptStreamLabel(streamKind),
        title: transcriptStreamTitle(streamKind),
        body: '',
        meta: `${prettify(streamKind)} • ${formatAbsoluteTime(lensEvent.createdAt)}`,
      }));
      contentEntry.body = appendTranscriptChunk(contentEntry.body, lensEvent.contentDelta.delta);
      contentEntry.meta = `${prettify(streamKind)} • ${formatAbsoluteTime(lensEvent.createdAt)}`;
      contentEntry.order = order;
    }

    if (lensEvent.planDelta || lensEvent.planCompleted) {
      const key = `plan:${lensEvent.turnId || lensEvent.sequence}`;
      const planEntry = ensureEntry(key, () => ({
        id: key,
        order,
        kind: 'plan',
        tone: 'info',
        label: 'Plan',
        title: 'Plan',
        body: '',
        meta: `Plan • ${formatAbsoluteTime(lensEvent.createdAt)}`,
      }));
      if (lensEvent.planDelta?.delta) {
        planEntry.body += lensEvent.planDelta.delta;
      }
      if (lensEvent.planCompleted?.planMarkdown) {
        planEntry.body = lensEvent.planCompleted.planMarkdown;
      }
      planEntry.meta = `Plan • ${formatAbsoluteTime(lensEvent.createdAt)}`;
      planEntry.order = order;
    }

    if (lensEvent.diffUpdated) {
      const key = `diff:${lensEvent.turnId || lensEvent.sequence}`;
      const diffEntry = ensureEntry(key, () => ({
        id: key,
        order,
        kind: 'diff',
        tone: 'warning',
        label: 'Diff',
        title: 'Working diff',
        body: lensEvent.diffUpdated?.unifiedDiff || '',
        meta: `Diff • ${formatAbsoluteTime(lensEvent.createdAt)}`,
      }));
      diffEntry.body = lensEvent.diffUpdated.unifiedDiff;
      diffEntry.meta = `Diff • ${formatAbsoluteTime(lensEvent.createdAt)}`;
      diffEntry.order = order;
    }

    if (
      lensEvent.requestOpened ||
      lensEvent.userInputRequested ||
      lensEvent.requestResolved ||
      lensEvent.userInputResolved
    ) {
      const requestId = lensEvent.requestId || `request:${lensEvent.sequence}`;
      const summary = requestSummaryById.get(requestId);
      const requestEntry = ensureEntry(`request:${requestId}`, () =>
        createRequestTranscriptEntry(requestId, summary, lensEvent, order),
      );
      updateRequestTranscriptEntry(requestEntry, summary, lensEvent);
      requestEntry.order = order;
    }

    const eventEntry = buildSystemEntryFromEvent(lensEvent, order);
    if (eventEntry) {
      entries.push(eventEntry);
    }
  }

  let fallbackOrder = snapshot.latestSequence + 1;
  for (const request of snapshot.requests) {
    const key = `request:${request.requestId}`;
    const entry = ensureEntry(key, () =>
      createRequestTranscriptEntry(request.requestId, request, null, fallbackOrder),
    );
    updateRequestTranscriptEntry(entry, request, null);
    entry.order = Math.max(entry.order, fallbackOrder);
    fallbackOrder += 1;
  }

  if (
    !entries.some((entry) => entry.kind === 'assistant' && entry.body.trim()) &&
    snapshot.streams.assistantText.trim()
  ) {
    entries.push({
      id: 'fallback-assistant',
      order: fallbackOrder,
      kind: 'assistant',
      tone: 'info',
      label: 'Assistant',
      title: 'Assistant',
      body: snapshot.streams.assistantText,
      meta: `Snapshot • ${formatAbsoluteTime(snapshot.generatedAt)}`,
    });
    fallbackOrder += 1;
  }

  if (
    !entries.some((entry) => entry.kind === 'plan' && entry.body.trim()) &&
    snapshot.streams.planText.trim()
  ) {
    entries.push({
      id: 'fallback-plan',
      order: fallbackOrder,
      kind: 'plan',
      tone: 'info',
      label: 'Plan',
      title: 'Plan',
      body: snapshot.streams.planText,
      meta: `Snapshot • ${formatAbsoluteTime(snapshot.generatedAt)}`,
    });
    fallbackOrder += 1;
  }

  if (
    !entries.some((entry) => entry.kind === 'diff' && entry.body.trim()) &&
    snapshot.streams.unifiedDiff.trim()
  ) {
    entries.push({
      id: 'fallback-diff',
      order: fallbackOrder,
      kind: 'diff',
      tone: 'warning',
      label: 'Diff',
      title: 'Working diff',
      body: snapshot.streams.unifiedDiff,
      meta: `Snapshot • ${formatAbsoluteTime(snapshot.generatedAt)}`,
    });
    fallbackOrder += 1;
  }

  if (
    !entries.some((entry) => entry.kind === 'tool' && entry.body.trim()) &&
    [snapshot.streams.commandOutput, snapshot.streams.fileChangeOutput].join('\n').trim()
  ) {
    entries.push({
      id: 'fallback-tool-output',
      order: fallbackOrder,
      kind: 'tool',
      tone: 'warning',
      label: 'Tool',
      title: 'Tool output',
      body: [snapshot.streams.commandOutput, snapshot.streams.fileChangeOutput]
        .filter(Boolean)
        .join('\n\n'),
      meta: `Snapshot • ${formatAbsoluteTime(snapshot.generatedAt)}`,
    });
  }

  return entries
    .filter(
      (entry) =>
        entry.body.trim() ||
        entry.kind === 'request' ||
        entry.kind === 'system' ||
        entry.kind === 'notice',
    )
    .sort((left, right) => left.order - right.order);
}

function withInlineLensStatus(
  snapshot: LensPulseSnapshotResponse,
  entries: LensTranscriptEntry[],
  streamConnected: boolean,
): LensTranscriptEntry[] {
  const hasConversation = entries.some((entry) =>
    ['user', 'assistant', 'tool', 'request', 'plan', 'diff'].includes(entry.kind),
  );
  const statusBody =
    snapshot.session.lastError?.trim() ||
    snapshot.session.reason?.trim() ||
    (streamConnected
      ? 'Lens is connected to MidTerm and waiting for transcript content.'
      : 'Lens is reconnecting to MidTerm.');

  if ((!statusBody || hasConversation) && !snapshot.session.lastError) {
    return entries;
  }

  return [
    {
      id: 'midterm-status',
      order: Number.MIN_SAFE_INTEGER,
      kind: snapshot.session.lastError ? 'notice' : 'system',
      tone: snapshot.session.lastError ? 'attention' : streamConnected ? 'positive' : 'warning',
      label: 'MidTerm',
      title: streamConnected ? 'Lens connected' : 'Lens connecting',
      body: statusBody,
      meta: streamConnected ? 'Connected' : 'Connecting',
    },
    ...entries,
  ];
}

function createRequestTranscriptEntry(
  requestId: string,
  request: LensPulseRequestSummary | undefined,
  lensEvent: LensPulseEvent | null,
  order: number,
): LensTranscriptEntry {
  return {
    id: `request:${requestId}`,
    order,
    kind: 'request',
    tone: request?.state === 'resolved' ? 'positive' : 'warning',
    label: 'Request',
    title:
      request?.kindLabel ||
      lensEvent?.requestOpened?.requestTypeLabel ||
      lensEvent?.type ||
      'Request',
    body:
      request?.detail ||
      lensEvent?.requestOpened?.detail ||
      lensEvent?.userInputRequested?.questions.map((question) => question.question).join('\n') ||
      'Action required.',
    meta: request
      ? `${prettify(request.state)} • ${formatAbsoluteTime(request.updatedAt)}`
      : `Request • ${lensEvent ? formatAbsoluteTime(lensEvent.createdAt) : ''}`.trim(),
    requestId,
  };
}

function updateRequestTranscriptEntry(
  entry: LensTranscriptEntry,
  request: LensPulseRequestSummary | undefined,
  lensEvent: LensPulseEvent | null,
): void {
  entry.kind = 'request';
  entry.label = 'Request';
  entry.tone = request?.state === 'resolved' ? 'positive' : 'warning';
  entry.title =
    request?.kindLabel ||
    lensEvent?.requestOpened?.requestTypeLabel ||
    lensEvent?.type ||
    entry.title;
  entry.body =
    summarizeRequest(request) ||
    lensEvent?.requestOpened?.detail ||
    lensEvent?.userInputRequested?.questions.map((question) => question.question).join('\n') ||
    entry.body;
  entry.meta = request
    ? `${prettify(request.state)} • ${formatAbsoluteTime(request.updatedAt)}`
    : lensEvent
      ? `${prettify(lensEvent.type)} • ${formatAbsoluteTime(lensEvent.createdAt)}`
      : entry.meta;
}

function buildSystemEntryFromEvent(
  lensEvent: LensPulseEvent,
  order: number,
): LensTranscriptEntry | null {
  if (lensEvent.runtimeMessage) {
    if (lensEvent.type !== 'runtime.error' && lensEvent.type !== 'runtime.warning') {
      return null;
    }
    return {
      id: `runtime:${lensEvent.eventId}`,
      order,
      kind: lensEvent.type === 'runtime.error' ? 'notice' : 'system',
      tone: lensEvent.type === 'runtime.error' ? 'attention' : toneFromEvent(lensEvent.type),
      label: lensEvent.type === 'runtime.error' ? 'Error' : 'Runtime',
      title: prettify(lensEvent.type),
      body: [lensEvent.runtimeMessage.message, lensEvent.runtimeMessage.detail]
        .filter(Boolean)
        .join('\n\n'),
      meta: `${prettify(lensEvent.type)} • ${formatAbsoluteTime(lensEvent.createdAt)}`,
    };
  }

  if (lensEvent.turnCompleted?.errorMessage) {
    return {
      id: `turn:${lensEvent.eventId}`,
      order,
      kind: 'notice',
      tone: toneFromEvent(lensEvent.type),
      label: 'Turn',
      title: lensEvent.turnCompleted.stateLabel || prettify(lensEvent.type),
      body: lensEvent.turnCompleted.errorMessage,
      meta: `${prettify(lensEvent.type)} • ${formatAbsoluteTime(lensEvent.createdAt)}`,
    };
  }

  return null;
}

function buildActivationTranscriptEntries(state: SessionLensViewState): LensTranscriptEntry[] {
  if (state.activationTrace.length === 0) {
    return [
      {
        id: 'activation:pending',
        order: 0,
        kind: 'system',
        tone: state.activationState === 'failed' ? 'attention' : 'warning',
        label: 'Boot',
        title: state.activationState === 'failed' ? 'Lens startup failed' : 'Opening Lens',
        body: state.activationDetail || 'Waiting for Lens boot steps…',
        meta: prettify(state.activationState),
      },
    ];
  }

  return state.activationTrace.map((entry, index) => ({
    id: `activation:${index}`,
    order: index,
    kind: entry.tone === 'attention' ? 'notice' : 'system',
    tone: entry.tone,
    label: 'Boot',
    title: entry.summary,
    body: entry.detail,
    meta: entry.meta,
  }));
}

function createTranscriptEntry(
  entry: LensTranscriptEntry,
  sessionId: string,
  busyRequestIds: ReadonlySet<string>,
): HTMLElement {
  const article = document.createElement('article');
  article.className = `agent-transcript-entry agent-transcript-${entry.kind} agent-transcript-${entry.tone}`;
  article.dataset.kind = entry.kind;
  article.dataset.tone = entry.tone;

  const header = document.createElement('div');
  header.className = 'agent-transcript-header';

  const badge = document.createElement('span');
  badge.className = `agent-transcript-badge agent-transcript-badge-${entry.kind}`;
  badge.textContent = entry.label;

  const meta = document.createElement('div');
  meta.className = 'agent-transcript-meta';
  meta.textContent = entry.meta;

  header.append(badge, meta);
  article.appendChild(header);

  const titleText = normalizeTranscriptTitle(entry);
  if (titleText) {
    const title = document.createElement('div');
    title.className = 'agent-transcript-title';
    title.textContent = titleText;
    article.appendChild(title);
  }

  const body = document.createElement(
    entry.kind === 'diff' || entry.kind === 'tool' || entry.kind === 'plan' ? 'pre' : 'div',
  );
  body.className = 'agent-transcript-body';
  if (entry.kind === 'assistant') {
    body.classList.add('agent-transcript-markdown');
    body.innerHTML = renderMarkdown(entry.body);
  } else {
    body.textContent = entry.body;
  }
  article.appendChild(body);

  if (entry.requestId) {
    const state = viewStates.get(sessionId);
    const request = state?.snapshot?.requests.find(
      (candidate) => candidate.requestId === entry.requestId,
    );
    if (request) {
      article.appendChild(
        createRequestActionBlock(sessionId, request, busyRequestIds.has(request.requestId)),
      );
    }
  }

  return article;
}

function createTranscriptSpacer(heightPx: number): HTMLElement {
  const spacer = document.createElement('div');
  spacer.className = 'agent-transcript-spacer';
  spacer.style.height = `${Math.max(0, Math.round(heightPx))}px`;
  return spacer;
}

function normalizeTranscriptTitle(entry: LensTranscriptEntry): string {
  const title = entry.title.trim();
  if (!title) {
    return '';
  }

  if ((entry.kind === 'user' || entry.kind === 'assistant') && title === entry.label) {
    return '';
  }

  return title;
}

function createRequestActionBlock(
  sessionId: string,
  request: LensPulseRequestSummary,
  busy: boolean,
): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'agent-request-actions';

  if (request.kind === 'tool_user_input' && request.questions.length > 0) {
    const form = document.createElement('form');
    form.className = 'agent-request-form';

    for (const question of request.questions) {
      form.appendChild(createQuestionField(question));
    }

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'agent-view-btn agent-view-btn-primary';
    submit.disabled = busy;
    submit.textContent = busy ? 'Sending…' : 'Send answer';
    form.appendChild(submit);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const answers = collectQuestionAnswers(form, request);
      void handleResolveUserInput(sessionId, request.requestId, answers);
    });

    actions.appendChild(form);
    return actions;
  }

  const buttonRow = document.createElement('div');
  buttonRow.className = 'agent-request-button-row';

  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'agent-view-btn agent-view-btn-primary';
  approve.disabled = busy;
  approve.textContent = busy ? 'Working…' : 'Approve';
  approve.addEventListener('click', () => {
    void handleApproveRequest(sessionId, request.requestId);
  });

  const decline = document.createElement('button');
  decline.type = 'button';
  decline.className = 'agent-view-btn';
  decline.disabled = busy;
  decline.textContent = 'Decline';
  decline.addEventListener('click', () => {
    void handleDeclineRequest(sessionId, request.requestId);
  });

  buttonRow.append(approve, decline);
  actions.appendChild(buttonRow);
  return actions;
}

function createQuestionField(question: LensPulseRequestSummary['questions'][number]): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'agent-request-field';

  const title = document.createElement('span');
  title.className = 'agent-request-question';
  title.textContent = question.header
    ? `${question.header}: ${question.question}`
    : question.question;
  wrapper.appendChild(title);

  if (question.options.length > 0 && question.multiSelect) {
    const options = document.createElement('div');
    options.className = 'agent-request-choice-list';
    for (const option of question.options) {
      const optionLabel = document.createElement('label');
      optionLabel.className = 'agent-request-choice';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = question.id;
      input.value = option.label;
      optionLabel.appendChild(input);
      optionLabel.append(` ${option.label}`);
      options.appendChild(optionLabel);
    }

    wrapper.appendChild(options);
    return wrapper;
  }

  if (question.options.length > 0) {
    const select = document.createElement('select');
    select.name = question.id;
    select.className = 'agent-request-input';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select…';
    select.appendChild(placeholder);

    for (const option of question.options) {
      const optionElement = document.createElement('option');
      optionElement.value = option.label;
      optionElement.textContent = option.label;
      select.appendChild(optionElement);
    }

    wrapper.appendChild(select);
    return wrapper;
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.name = question.id;
  input.className = 'agent-request-input';
  input.placeholder = 'Type answer';
  wrapper.appendChild(input);
  return wrapper;
}

function collectQuestionAnswers(
  form: HTMLFormElement,
  request: LensPulseRequestSummary,
): Array<{ questionId: string; answers: string[] }> {
  return request.questions.map((question) => {
    if (question.options.length > 0 && question.multiSelect) {
      const answers = Array.from(
        form.querySelectorAll<HTMLInputElement>(`input[name="${CSS.escape(question.id)}"]:checked`),
      ).map((input) => input.value);
      return { questionId: question.id, answers };
    }

    const field = form.querySelector<HTMLInputElement | HTMLSelectElement>(
      `[name="${CSS.escape(question.id)}"]`,
    );
    const value = field?.value.trim() ?? '';
    return { questionId: question.id, answers: value ? [value] : [] };
  });
}

function renderEmptyContainer(container: HTMLElement, text: string): void {
  const empty = document.createElement('div');
  empty.className = 'agent-transcript-empty';
  empty.textContent = text;
  container.replaceChildren(empty);
}

export function isScrollContainerNearBottom(position: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}): boolean {
  const { scrollTop, clientHeight, scrollHeight } = position;
  if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) {
    return true;
  }

  return scrollHeight - clientHeight - scrollTop <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
}

export function estimateTranscriptEntryHeight(entry: LensTranscriptEntry): number {
  const bodyLength = entry.body.length;
  const lineCount = Math.max(1, entry.body.split('\n').length);
  const wrappedLines = Math.ceil(bodyLength / 90);
  const textLines = Math.max(lineCount, wrappedLines);
  const bodyHeight = Math.min(420, 18 * textLines);

  switch (entry.kind) {
    case 'tool':
    case 'diff':
    case 'plan':
      return 84 + bodyHeight;
    case 'request':
      return 108 + bodyHeight;
    case 'user':
      return 68 + bodyHeight;
    case 'assistant':
      return 52 + bodyHeight;
    case 'notice':
      return 64 + bodyHeight;
    default:
      return 54 + bodyHeight;
  }
}

export function computeTranscriptVirtualWindow(
  entries: ReadonlyArray<LensTranscriptEntry>,
  scrollTop: number,
  clientHeight: number,
): TranscriptVirtualWindow {
  if (entries.length <= TRANSCRIPT_VIRTUALIZE_AFTER) {
    return {
      start: 0,
      end: entries.length,
      topSpacerPx: 0,
      bottomSpacerPx: 0,
    };
  }

  const targetTop = Math.max(0, scrollTop - TRANSCRIPT_OVERSCAN_PX);
  const targetBottom = scrollTop + clientHeight + TRANSCRIPT_OVERSCAN_PX;
  let cumulative = 0;
  let start = 0;
  let topSpacerPx = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }

    const height = estimateTranscriptEntryHeight(entry);
    if (cumulative + height >= targetTop) {
      start = index;
      topSpacerPx = cumulative;
      break;
    }
    cumulative += height;
  }

  cumulative = topSpacerPx;
  let end = start;
  while (end < entries.length && cumulative < targetBottom) {
    const entry = entries[end];
    if (!entry) {
      break;
    }

    cumulative += estimateTranscriptEntryHeight(entry);
    end += 1;
  }

  const totalHeight = entries.reduce((sum, entry) => sum + estimateTranscriptEntryHeight(entry), 0);

  return {
    start,
    end: Math.max(end, start + 1),
    topSpacerPx,
    bottomSpacerPx: Math.max(0, totalHeight - cumulative),
  };
}

function appendTranscriptChunk(existing: string, delta: string): string {
  const trimmedDelta = delta.trim();
  if (!trimmedDelta) {
    return existing;
  }

  const trimmedExisting = existing.trimEnd();
  if (!trimmedExisting) {
    return trimmedDelta;
  }

  if (trimmedExisting.includes(trimmedDelta)) {
    return trimmedExisting;
  }

  const separator = trimmedExisting.endsWith('\n') || trimmedDelta.startsWith('\n') ? '\n' : '\n\n';
  return `${trimmedExisting}${separator}${trimmedDelta}`;
}

function resolveTranscriptItemBody(
  kind: TranscriptKind,
  detail: string | null | undefined,
  title: string | null | undefined,
): string {
  if (kind === 'tool') {
    return detail?.trim() || '';
  }

  const trimmedDetail = detail?.trim();
  if (trimmedDetail) {
    return trimmedDetail;
  }

  const trimmedTitle = title?.trim() || '';
  if (!trimmedTitle || isGenericTranscriptPlaceholder(kind, trimmedTitle)) {
    return '';
  }

  return trimmedTitle;
}

function isGenericTranscriptPlaceholder(kind: TranscriptKind, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  const genericValues = new Set([
    transcriptLabel(kind).toLowerCase(),
    'assistant message',
    'user message',
    'user input',
    'agent message',
    'message',
    'tool started',
    'tool completed',
    'started',
    'completed',
  ]);
  return genericValues.has(normalized);
}

function compactToolTitle(value: string): string {
  return value
    .replace(/\s+(?:complete|completed)\s*$/i, '')
    .replace(/^tool[:\s-]*/i, '')
    .trim();
}

async function handleApproveRequest(sessionId: string, requestId: string): Promise<void> {
  await runRequestAction(sessionId, requestId, () => approveLensRequest(sessionId, requestId));
}

async function handleDeclineRequest(sessionId: string, requestId: string): Promise<void> {
  await runRequestAction(sessionId, requestId, () => declineLensRequest(sessionId, requestId));
}

async function handleResolveUserInput(
  sessionId: string,
  requestId: string,
  answers: Array<{ questionId: string; answers: string[] }>,
): Promise<void> {
  await runRequestAction(sessionId, requestId, () =>
    resolveLensUserInput(sessionId, requestId, {
      answers: answers.filter((answer) => answer.answers.length > 0),
    }),
  );
}

async function runRequestAction(
  sessionId: string,
  requestId: string,
  action: () => Promise<unknown>,
): Promise<void> {
  const state = viewStates.get(sessionId);
  if (!state || state.requestBusyIds.has(requestId)) {
    return;
  }

  state.requestBusyIds.add(requestId);
  renderCurrentAgentView(sessionId);
  try {
    await action();
    await refreshLensSnapshot(sessionId);
  } catch (error) {
    log.warn(
      () => `Failed to resolve Lens request ${requestId} for ${sessionId}: ${String(error)}`,
    );
    showDevErrorDialog({
      title: 'Lens request failed',
      context: `Lens request action failed for session ${sessionId}, request ${requestId}`,
      error,
    });
  } finally {
    state.requestBusyIds.delete(requestId);
    renderCurrentAgentView(sessionId);
  }
}

async function waitForInitialLensSnapshot(
  sessionId: string,
  state: SessionLensViewState,
): Promise<LensPulseSnapshotResponse> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const snapshot = await getLensSnapshot(sessionId);
      if (attempt > 1) {
        appendActivationTrace(
          state,
          'positive',
          `snapshot retry ${attempt}`,
          'Lens snapshot became available.',
          `MidTerm produced the first canonical Lens snapshot on retry ${attempt}.`,
        );
      }
      return snapshot;
    } catch (error) {
      lastError = error;
      appendActivationTrace(
        state,
        attempt === 12 ? 'attention' : 'warning',
        `snapshot retry ${attempt}`,
        'Lens snapshot not ready yet.',
        describeError(error),
      );
      renderCurrentAgentView(sessionId);
      if (attempt < 12) {
        await new Promise((resolve) => window.setTimeout(resolve, 200));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function setActivationState(
  state: SessionLensViewState,
  activationState: SessionLensViewState['activationState'],
  activationDetail: string,
  summary: string,
  detail: string,
  tone: TranscriptTone = 'info',
): void {
  state.activationState = activationState;
  state.activationDetail = activationDetail;
  appendActivationTrace(state, tone, activationState, summary, detail);
}

function appendActivationTrace(
  state: SessionLensViewState,
  tone: TranscriptTone,
  phase: string,
  summary: string,
  detail: string,
): void {
  state.activationTrace = [
    ...state.activationTrace,
    {
      tone,
      meta: `${prettify(phase)} • ${formatClockTime(new Date())}`,
      summary,
      detail,
    },
  ].slice(-12);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack?.trim() || error.message || error.name;
  }

  return typeof error === 'string' ? error : JSON.stringify(error, null, 2);
}

function summarizeRequest(request: LensPulseRequestSummary | undefined): string {
  if (!request) {
    return '';
  }

  if (request.questions.length > 0) {
    return request.questions.map((question) => question.question).join('\n');
  }

  if (request.answers.length > 0) {
    return request.answers
      .map((answer) => `${answer.questionId}: ${answer.answers.join(', ')}`)
      .join('\n');
  }

  return request.detail || request.turnId || '';
}

function toneFromEvent(eventType: string): TranscriptTone {
  if (eventType.endsWith('error')) {
    return 'attention';
  }
  if (
    eventType.endsWith('warning') ||
    eventType.includes('request') ||
    eventType.includes('aborted')
  ) {
    return 'warning';
  }
  if (
    eventType.endsWith('completed') ||
    eventType.endsWith('resolved') ||
    eventType.endsWith('ready')
  ) {
    return 'positive';
  }
  return 'info';
}

function toneFromState(state: string | null | undefined): TranscriptTone {
  const normalized = (state || '').toLowerCase();
  if (
    normalized.includes('error') ||
    normalized.includes('failed') ||
    normalized.includes('declined')
  ) {
    return 'attention';
  }
  if (
    normalized.includes('running') ||
    normalized.includes('active') ||
    normalized.includes('open') ||
    normalized.includes('in_progress')
  ) {
    return 'warning';
  }
  if (
    normalized.includes('ready') ||
    normalized.includes('completed') ||
    normalized.includes('resolved') ||
    normalized.includes('idle')
  ) {
    return 'positive';
  }
  return 'info';
}

function transcriptKindFromItem(itemType: string): TranscriptKind {
  const normalized = itemType.toLowerCase();
  if (normalized.includes('assistant')) {
    return 'assistant';
  }
  if (normalized.includes('user') || normalized.includes('input')) {
    return 'user';
  }
  return 'tool';
}

function transcriptKindFromStream(streamKind: string): TranscriptKind | null {
  const normalized = streamKind.toLowerCase();
  if (normalized === 'assistant_text') {
    return 'assistant';
  }
  if (normalized === 'command_output' || normalized === 'file_change_output') {
    return 'tool';
  }
  return null;
}

function transcriptLabel(kind: TranscriptKind): string {
  switch (kind) {
    case 'user':
      return 'You';
    case 'assistant':
      return 'Assistant';
    case 'tool':
      return 'Tool';
    case 'request':
      return 'Request';
    case 'plan':
      return 'Plan';
    case 'diff':
      return 'Diff';
    case 'notice':
      return 'Error';
    default:
      return 'System';
  }
}

function transcriptStreamLabel(streamKind: string): string {
  switch (streamKind) {
    case 'assistant_text':
      return 'Assistant';
    case 'reasoning_text':
    case 'reasoning_summary_text':
      return 'Reasoning';
    case 'command_output':
    case 'file_change_output':
      return 'Tool';
    default:
      return prettify(streamKind);
  }
}

function transcriptStreamTitle(streamKind: string): string {
  switch (streamKind) {
    case 'assistant_text':
      return 'Assistant response';
    case 'reasoning_text':
      return 'Reasoning';
    case 'reasoning_summary_text':
      return 'Reasoning summary';
    case 'command_output':
      return 'Command output';
    case 'file_change_output':
      return 'File change output';
    default:
      return prettify(streamKind);
  }
}

function prettify(value: string): string {
  return value
    .replace(/[_./-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function formatAbsoluteTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function formatClockTime(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value);
}
