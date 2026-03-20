import { t } from '../i18n';
import { createLogger } from '../logging';
import { onTabActivated, onTabDeactivated, switchTab } from '../sessionTabs';
import { showDevErrorDialog } from '../../utils/devErrorDialog';
import {
  attachSessionLens,
  getLensSnapshot,
  getLensEvents,
  interruptLensTurn,
  approveLensRequest,
  declineLensRequest,
  resolveLensUserInput,
  openLensEventStream,
  type LensPulseEvent,
  type LensPulseRequestSummary,
  type LensPulseRuntimeNotice,
  type LensPulseSnapshotResponse,
} from '../../api/client';

const log = createLogger('agentView');
const viewStates = new Map<string, SessionLensViewState>();

interface SessionLensViewState {
  panel: HTMLDivElement;
  snapshot: LensPulseSnapshotResponse | null;
  events: LensPulseEvent[];
  disconnectStream: (() => void) | null;
  streamConnected: boolean;
  refreshScheduled: number | null;
  refreshInFlight: boolean;
  interruptPending: boolean;
  requestBusyIds: Set<string>;
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

export function initAgentView(): void {
  onTabActivated('agent', (sessionId, panel) => {
    ensureAgentViewSkeleton(sessionId, panel);
    const state = getOrCreateViewState(sessionId, panel);
    state.panel = panel;
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
    disconnectStream: null,
    streamConnected: false,
    refreshScheduled: null,
    refreshInFlight: false,
    interruptPending: false,
    requestBusyIds: new Set<string>(),
    activationState: 'idle',
    activationDetail: '',
    activationTrace: [],
    activationError: null,
  };

  viewStates.set(sessionId, created);
  return created;
}

function ensureAgentViewSkeleton(sessionId: string, panel: HTMLDivElement): void {
  if (panel.dataset.agentViewReady === 'true') {
    return;
  }

  panel.dataset.agentViewReady = 'true';
  panel.classList.add('agent-view-panel');
  panel.innerHTML = `
    <section class="agent-view">
      <div class="agent-view-hero">
        <div class="agent-view-copy">
          <div class="agent-view-eyebrow">${t('agentView.eyebrow')}</div>
          <h2 class="agent-view-title" data-agent-field="title"></h2>
          <p class="agent-view-subtitle" data-agent-field="subtitle"></p>
        </div>
        <div class="agent-view-actions">
          <button type="button" class="agent-view-btn" data-agent-action="refresh">${t('agentView.refresh')}</button>
          <button type="button" class="agent-view-btn" data-agent-action="interrupt" hidden>Stop turn</button>
          <button type="button" class="agent-view-btn agent-view-btn-primary" data-agent-action="terminal">${t('agentView.openTerminal')}</button>
        </div>
      </div>
      <div class="agent-view-chip-row" data-agent-field="chips"></div>
      <div class="agent-lens-layout">
        <section class="agent-transcript-card">
          <div class="agent-card-header">
            <div>
              <div class="agent-card-label">Transcript</div>
              <div class="agent-card-meta" data-agent-field="transcript-meta"></div>
            </div>
          </div>
          <div class="agent-transcript" data-agent-field="transcript"></div>
        </section>
        <aside class="agent-side-rail">
          <section class="agent-card">
            <div class="agent-card-label">Session</div>
            <div class="agent-summary-list" data-agent-field="summary"></div>
          </section>
          <section class="agent-card">
            <div class="agent-card-header">
              <div>
                <div class="agent-card-label">Requests</div>
                <div class="agent-card-meta">Open approvals and structured questions.</div>
              </div>
            </div>
            <div class="agent-side-list" data-agent-field="requests"></div>
          </section>
          <section class="agent-card">
            <div class="agent-card-header">
              <div>
                <div class="agent-card-label">Notices</div>
                <div class="agent-card-meta">Warnings and runtime failures from the Lens host.</div>
              </div>
            </div>
            <div class="agent-side-list" data-agent-field="notices"></div>
          </section>
          <section class="agent-card">
            <div class="agent-card-header">
              <div>
                <div class="agent-card-label">Raw Events</div>
                <div class="agent-card-meta">Latest canonical Lens events for debugging.</div>
              </div>
            </div>
            <div class="agent-side-list" data-agent-field="events"></div>
          </section>
        </aside>
      </div>
    </section>
  `;

  panel
    .querySelector<HTMLButtonElement>('[data-agent-action="refresh"]')
    ?.addEventListener('click', () => {
      void refreshLensSnapshot(sessionId);
    });

  panel
    .querySelector<HTMLButtonElement>('[data-agent-action="interrupt"]')
    ?.addEventListener('click', () => {
      const turnId = panel.dataset.agentTurnId;
      if (!turnId) {
        return;
      }

      void handleInterruptTurn(sessionId, turnId);
    });

  panel
    .querySelector<HTMLButtonElement>('[data-agent-action="terminal"]')
    ?.addEventListener('click', () => {
      switchTab(sessionId, 'terminal');
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
  const providerLabel = prettify(snapshot.provider || 'agent');
  const openRequests = snapshot.requests.filter((request) => request.state !== 'resolved');
  const latestNotice = snapshot.notices[0] ?? null;

  setText(panel, 'title', `${providerLabel} Lens`);
  setText(
    panel,
    'subtitle',
    snapshot.session.reason ??
      `Thread ${snapshot.thread.threadId || snapshot.sessionId} • sequence ${snapshot.latestSequence}`,
  );
  setText(
    panel,
    'transcript-meta',
    streamConnected
      ? 'Live canonical transcript from MidTerm.'
      : 'Transcript is reconnecting to the live event stream.',
  );

  panel.dataset.agentTurnId = snapshot.currentTurn.turnId || '';
  syncInterruptAction(panel, snapshot, state.interruptPending);
  renderChips(panel, snapshot, latestNotice !== null, streamConnected);
  renderSummary(panel, snapshot, openRequests.length);
  renderRequestList(panel, snapshot.sessionId, snapshot.requests, state.requestBusyIds);
  renderNotices(panel, snapshot.notices);
  renderEvents(panel, events);
  renderTranscript(
    panel,
    buildLensTranscriptEntries(snapshot, events),
    snapshot.sessionId,
    state.requestBusyIds,
  );
}

function renderActivationView(panel: HTMLDivElement, state: SessionLensViewState): void {
  const failed = state.activationState === 'failed';
  const title = failed ? 'Lens startup failed' : 'Opening Lens';
  const subtitle =
    state.activationDetail || (failed ? t('agentView.loadError') : 'Connecting Lens runtime…');

  panel.dataset.agentTurnId = '';
  setText(panel, 'title', title);
  setText(panel, 'subtitle', subtitle);
  setText(
    panel,
    'transcript-meta',
    failed ? 'Lens never reached a stable transcript state.' : 'Boot progress stays visible here.',
  );
  renderActivationChips(panel, state);
  renderActivationSummary(panel, state);
  renderTranscript(panel, buildActivationTranscriptEntries(state), '', new Set<string>());
  renderActivationRequests(panel, state);
  renderActivationNotices(panel, state.activationTrace, state.activationError);
  renderActivationEvents(panel, state.activationTrace);

  const interruptButton = panel.querySelector<HTMLButtonElement>('[data-agent-action="interrupt"]');
  if (interruptButton) {
    interruptButton.hidden = true;
    interruptButton.disabled = false;
    interruptButton.textContent = 'Stop turn';
  }
}

function renderSummary(
  panel: HTMLDivElement,
  snapshot: LensPulseSnapshotResponse,
  openRequestCount: number,
): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="summary"]');
  if (!container) {
    return;
  }

  const summaryEntries = [
    {
      label: 'Session',
      value: snapshot.session.stateLabel || prettify(snapshot.session.state || 'unknown'),
      meta: snapshot.session.lastEventAt
        ? `Last event ${formatAbsoluteTime(snapshot.session.lastEventAt)}`
        : snapshot.session.reason || 'No session updates yet.',
    },
    {
      label: 'Thread',
      value: snapshot.thread.stateLabel || prettify(snapshot.thread.state || 'unknown'),
      meta: snapshot.thread.threadId || 'Provider thread pending',
    },
    {
      label: 'Turn',
      value: summarizeTurnState(snapshot),
      meta: summarizeTurnMeta(snapshot),
    },
    {
      label: 'Requests',
      value: `${openRequestCount}/${snapshot.requests.length}`,
      meta: openRequestCount > 0 ? 'Action needed in transcript.' : 'No open requests.',
    },
  ];

  const fragment = document.createDocumentFragment();
  for (const entry of summaryEntries) {
    const row = document.createElement('div');
    row.className = 'agent-summary-item';

    const label = document.createElement('div');
    label.className = 'agent-summary-label';
    label.textContent = entry.label;

    const value = document.createElement('div');
    value.className = 'agent-summary-value';
    value.textContent = entry.value;

    const meta = document.createElement('div');
    meta.className = 'agent-summary-meta';
    meta.textContent = entry.meta;

    row.append(label, value, meta);
    fragment.appendChild(row);
  }

  container.replaceChildren(fragment);
}

function renderActivationSummary(panel: HTMLDivElement, state: SessionLensViewState): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="summary"]');
  if (!container) {
    return;
  }

  const summaryEntries = [
    {
      label: 'Stage',
      value: prettify(state.activationState),
      meta: state.activationDetail,
    },
    {
      label: 'Live Stream',
      value: state.streamConnected ? 'Connected' : 'Connecting',
      meta: state.streamConnected
        ? 'SSE stream is open.'
        : 'Waiting for first stable runtime events.',
    },
    {
      label: 'Snapshot',
      value: state.activationState === 'failed' ? 'Unavailable' : 'Pending',
      meta: failedCopy(state),
    },
  ];

  const fragment = document.createDocumentFragment();
  for (const entry of summaryEntries) {
    const row = document.createElement('div');
    row.className = 'agent-summary-item';

    const label = document.createElement('div');
    label.className = 'agent-summary-label';
    label.textContent = entry.label;

    const value = document.createElement('div');
    value.className = 'agent-summary-value';
    value.textContent = entry.value;

    const meta = document.createElement('div');
    meta.className = 'agent-summary-meta';
    meta.textContent = entry.meta;

    row.append(label, value, meta);
    fragment.appendChild(row);
  }

  container.replaceChildren(fragment);
}

function renderChips(
  panel: HTMLDivElement,
  snapshot: LensPulseSnapshotResponse,
  hasRuntimeNotice: boolean,
  streamConnected: boolean,
): void {
  const chips = [
    { tone: 'profile', text: prettify(snapshot.provider || 'agent') },
    {
      tone: toneFromState(snapshot.session.state),
      text: snapshot.session.stateLabel || snapshot.session.state,
    },
    {
      tone: toneFromState(snapshot.thread.state),
      text: snapshot.thread.stateLabel || snapshot.thread.state,
    },
  ];

  if (snapshot.currentTurn.turnId) {
    chips.push({
      tone: toneFromState(snapshot.currentTurn.state),
      text: snapshot.currentTurn.stateLabel || snapshot.currentTurn.state,
    });
  }

  if (hasRuntimeNotice) {
    chips.push({ tone: 'attention', text: 'Notice' });
  }

  chips.push({
    tone: streamConnected ? 'positive' : 'warning',
    text: streamConnected ? 'Live' : 'Reconnecting',
  });

  renderChipContainer(panel, chips);
}

function renderActivationChips(panel: HTMLDivElement, state: SessionLensViewState): void {
  renderChipContainer(panel, [
    { tone: 'profile', text: 'Lens Boot' },
    {
      tone:
        state.activationState === 'failed'
          ? 'attention'
          : state.activationState === 'ready'
            ? 'positive'
            : 'warning',
      text: prettify(state.activationState),
    },
    {
      tone: state.streamConnected ? 'positive' : 'warning',
      text: state.streamConnected ? 'Live' : 'Connecting',
    },
  ]);
}

function renderChipContainer(
  panel: HTMLDivElement,
  chips: Array<{ tone: string; text: string }>,
): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="chips"]');
  if (!container) {
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const chip of chips) {
    const node = document.createElement('span');
    node.className = `agent-chip agent-chip-${chip.tone.replace(/[^a-z0-9-]/gi, '-')}`;
    node.textContent = chip.text;
    fragment.appendChild(node);
  }

  container.replaceChildren(fragment);
}

function syncInterruptAction(
  panel: HTMLDivElement,
  snapshot: LensPulseSnapshotResponse,
  pending: boolean,
): void {
  const button = panel.querySelector<HTMLButtonElement>('[data-agent-action="interrupt"]');
  if (!button) {
    return;
  }

  const canInterrupt =
    Boolean(snapshot.currentTurn.turnId) &&
    !['completed', 'interrupted', 'failed', 'error'].includes(
      (snapshot.currentTurn.state || '').toLowerCase(),
    );

  button.hidden = !canInterrupt;
  button.disabled = pending;
  button.textContent = pending ? 'Stopping…' : 'Stop turn';
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

  if (entries.length === 0) {
    renderEmptyContainer(container, 'No transcript entries yet.');
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    fragment.appendChild(createTranscriptEntry(entry, sessionId, busyRequestIds));
  }

  container.replaceChildren(fragment);
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
      const itemEntry = ensureEntry(`item:${lensEvent.itemId}`, () => ({
        id: `item:${lensEvent.itemId}`,
        order,
        kind: itemKind,
        tone: toneFromState(lensEvent.item?.status),
        label: transcriptLabel(itemKind),
        title: lensEvent.item?.title || prettify(lensEvent.item?.itemType || 'item'),
        body: lensEvent.item?.detail || lensEvent.item?.title || '',
        meta: `${prettify(lensEvent.item?.status || 'updated')} • ${formatAbsoluteTime(lensEvent.createdAt)}`,
      }));
      itemEntry.kind = itemKind;
      itemEntry.tone = toneFromState(lensEvent.item.status);
      itemEntry.label = transcriptLabel(itemKind);
      itemEntry.title = lensEvent.item.title || prettify(lensEvent.item.itemType || 'item');
      itemEntry.body = lensEvent.item.detail || lensEvent.item.title || itemEntry.body;
      itemEntry.meta = `${prettify(lensEvent.item.status)} • ${formatAbsoluteTime(lensEvent.createdAt)}`;
      itemEntry.order = order;
    }

    if (lensEvent.contentDelta) {
      const streamKind = lensEvent.contentDelta.streamKind;
      const transcriptKind = transcriptKindFromStream(streamKind);
      const key = `${transcriptKind}:${lensEvent.itemId || lensEvent.turnId || lensEvent.sequence}:${streamKind}`;
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
      contentEntry.body += lensEvent.contentDelta.delta;
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
    !entries.some((entry) => entry.kind === 'assistant') &&
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

  if (!entries.some((entry) => entry.kind === 'plan') && snapshot.streams.planText.trim()) {
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

  if (!entries.some((entry) => entry.kind === 'diff') && snapshot.streams.unifiedDiff.trim()) {
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
    !entries.some((entry) => entry.kind === 'tool') &&
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

  if (lensEvent.turnStarted || lensEvent.turnCompleted) {
    return {
      id: `turn:${lensEvent.eventId}`,
      order,
      kind: 'system',
      tone: toneFromEvent(lensEvent.type),
      label: 'Turn',
      title: lensEvent.turnCompleted?.stateLabel || prettify(lensEvent.type),
      body:
        [
          lensEvent.turnStarted?.model,
          lensEvent.turnStarted?.effort,
          lensEvent.turnCompleted?.stopReason,
        ]
          .filter(Boolean)
          .join(' • ') || 'Turn lifecycle update.',
      meta: `${prettify(lensEvent.type)} • ${formatAbsoluteTime(lensEvent.createdAt)}`,
    };
  }

  if (lensEvent.sessionState || lensEvent.threadState) {
    return {
      id: `state:${lensEvent.eventId}`,
      order,
      kind: 'system',
      tone: toneFromEvent(lensEvent.type),
      label: lensEvent.sessionState ? 'Session' : 'Thread',
      title:
        lensEvent.sessionState?.stateLabel ||
        lensEvent.threadState?.stateLabel ||
        prettify(lensEvent.type),
      body:
        lensEvent.sessionState?.reason ||
        lensEvent.threadState?.providerThreadId ||
        'State update.',
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

function renderRequestList(
  panel: HTMLDivElement,
  sessionId: string,
  requests: LensPulseRequestSummary[],
  busyRequestIds: ReadonlySet<string>,
): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="requests"]');
  if (!container) {
    return;
  }

  if (requests.length === 0) {
    renderEmptyContainer(container, 'No request cards right now.');
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const request of requests.slice(0, 8)) {
    fragment.appendChild(
      createRequestSideItem(sessionId, request, busyRequestIds.has(request.requestId)),
    );
  }
  container.replaceChildren(fragment);
}

function renderActivationRequests(panel: HTMLDivElement, state: SessionLensViewState): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="requests"]');
  if (!container) {
    return;
  }

  renderEmptyContainer(
    container,
    state.activationState === 'failed'
      ? 'Lens startup failed before request cards became available.'
      : 'Request cards will appear here once the runtime is attached.',
  );
}

function renderNotices(panel: HTMLDivElement, notices: LensPulseRuntimeNotice[]): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="notices"]');
  if (!container) {
    return;
  }

  if (notices.length === 0) {
    renderEmptyContainer(container, 'No runtime notices.');
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const notice of notices.slice(0, 8)) {
    fragment.appendChild(
      createSideItem(
        notice.type === 'runtime.error' ? 'attention' : 'warning',
        `${notice.type} • ${formatAbsoluteTime(notice.createdAt)}`,
        notice.message,
        notice.detail || 'No extra detail',
      ),
    );
  }

  container.replaceChildren(fragment);
}

function renderActivationNotices(
  panel: HTMLDivElement,
  trace: LensActivationTraceEntry[],
  activationError: string | null,
): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="notices"]');
  if (!container) {
    return;
  }

  const fragment = document.createDocumentFragment();
  if (activationError) {
    fragment.appendChild(
      createSideItem('attention', 'startup failure', 'Lens startup failed.', activationError),
    );
  }

  for (const entry of trace
    .filter((item) => item.tone !== 'info')
    .slice(-4)
    .reverse()) {
    fragment.appendChild(createSideItem(entry.tone, entry.meta, entry.summary, entry.detail));
  }

  if (!fragment.childNodes.length) {
    renderEmptyContainer(container, 'No runtime notices yet.');
    return;
  }

  container.replaceChildren(fragment);
}

function renderEvents(panel: HTMLDivElement, events: LensPulseEvent[]): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="events"]');
  if (!container) {
    return;
  }

  if (events.length === 0) {
    renderEmptyContainer(container, 'No Lens events yet.');
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const lensEvent of [...events].slice(-12).reverse()) {
    fragment.appendChild(
      createSideItem(
        toneFromEvent(lensEvent.type),
        `${lensEvent.type} • ${formatAbsoluteTime(lensEvent.createdAt)}`,
        summarizeEvent(lensEvent),
        summarizeEventDetail(lensEvent),
      ),
    );
  }

  container.replaceChildren(fragment);
}

function renderActivationEvents(panel: HTMLDivElement, trace: LensActivationTraceEntry[]): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="events"]');
  if (!container) {
    return;
  }

  if (trace.length === 0) {
    renderEmptyContainer(container, 'Lens startup has not emitted any boot steps yet.');
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of [...trace].reverse()) {
    fragment.appendChild(createSideItem(entry.tone, entry.meta, entry.summary, entry.detail));
  }

  container.replaceChildren(fragment);
}

function createTranscriptEntry(
  entry: LensTranscriptEntry,
  sessionId: string,
  busyRequestIds: ReadonlySet<string>,
): HTMLElement {
  const article = document.createElement('article');
  article.className = `agent-transcript-entry agent-transcript-${entry.kind} agent-transcript-${entry.tone}`;

  const header = document.createElement('div');
  header.className = 'agent-transcript-header';

  const badge = document.createElement('span');
  badge.className = `agent-transcript-badge agent-transcript-badge-${entry.kind}`;
  badge.textContent = entry.label;

  const title = document.createElement('div');
  title.className = 'agent-transcript-title';
  title.textContent = entry.title;

  const meta = document.createElement('div');
  meta.className = 'agent-transcript-meta';
  meta.textContent = entry.meta;

  header.append(badge, title, meta);
  article.appendChild(header);

  const body = document.createElement(
    entry.kind === 'diff' || entry.kind === 'tool' || entry.kind === 'plan' ? 'pre' : 'div',
  );
  body.className = 'agent-transcript-body';
  body.textContent = entry.body;
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

function createSideItem(
  tone: string,
  metaText: string,
  summaryText: string,
  detailText: string,
): HTMLElement {
  const item = document.createElement('article');
  item.className = `agent-side-item agent-side-${tone.replace(/[^a-z0-9-]/gi, '-')}`;

  const meta = document.createElement('div');
  meta.className = 'agent-side-meta';
  meta.textContent = metaText;

  const summary = document.createElement('div');
  summary.className = 'agent-side-summary';
  summary.textContent = summaryText;

  const detail = document.createElement('div');
  detail.className = 'agent-side-detail';
  detail.textContent = detailText;

  item.append(meta, summary, detail);
  return item;
}

function createRequestSideItem(
  sessionId: string,
  request: LensPulseRequestSummary,
  busy: boolean,
): HTMLElement {
  const item = createSideItem(
    request.state === 'resolved' ? 'positive' : 'warning',
    `${request.kindLabel} • ${formatAbsoluteTime(request.updatedAt)}`,
    request.detail || summarizeRequest(request) || request.kindLabel,
    request.state === 'resolved' && request.decision
      ? `Resolved as ${request.decision}`
      : request.state === 'resolved'
        ? 'Resolved'
        : 'Open',
  );

  if (request.state !== 'resolved') {
    item.appendChild(createRequestActionBlock(sessionId, request, busy));
  }

  return item;
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
  empty.className = 'agent-side-empty';
  empty.textContent = text;
  container.replaceChildren(empty);
}

function setText(panel: HTMLDivElement, field: string, value: string): void {
  const element = panel.querySelector<HTMLElement>(`[data-agent-field="${field}"]`);
  if (element) {
    element.textContent = value;
  }
}

async function handleInterruptTurn(sessionId: string, turnId: string): Promise<void> {
  const state = viewStates.get(sessionId);
  if (!state || state.interruptPending) {
    return;
  }

  state.interruptPending = true;
  renderCurrentAgentView(sessionId);
  try {
    await interruptLensTurn(sessionId, { turnId });
    await refreshLensSnapshot(sessionId);
  } catch (error) {
    log.warn(() => `Failed to interrupt Lens turn for ${sessionId}: ${String(error)}`);
    showDevErrorDialog({
      title: 'Lens interrupt failed',
      context: `Lens interrupt failed for session ${sessionId}, turn ${turnId}`,
      error,
    });
  } finally {
    state.interruptPending = false;
    renderCurrentAgentView(sessionId);
  }
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

function summarizeTurnState(snapshot: LensPulseSnapshotResponse): string {
  if (!snapshot.currentTurn.turnId) {
    return 'Idle';
  }

  return snapshot.currentTurn.stateLabel || prettify(snapshot.currentTurn.state || 'running');
}

function summarizeTurnMeta(snapshot: LensPulseSnapshotResponse): string {
  if (!snapshot.currentTurn.turnId) {
    return 'No active turn';
  }

  return [snapshot.currentTurn.turnId, snapshot.currentTurn.model, snapshot.currentTurn.effort]
    .filter(Boolean)
    .join(' • ');
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

function summarizeEvent(lensEvent: LensPulseEvent): string {
  return (
    lensEvent.runtimeMessage?.message ||
    lensEvent.item?.title ||
    lensEvent.requestOpened?.detail ||
    lensEvent.requestResolved?.decision ||
    lensEvent.turnCompleted?.errorMessage ||
    lensEvent.contentDelta?.delta ||
    lensEvent.planCompleted?.planMarkdown ||
    lensEvent.planDelta?.delta ||
    lensEvent.diffUpdated?.unifiedDiff ||
    lensEvent.userInputRequested?.questions.map((question) => question.question).join(' • ') ||
    lensEvent.userInputResolved?.answers
      .map((answer) => `${answer.questionId}: ${answer.answers.join(', ')}`)
      .join(' • ') ||
    lensEvent.sessionState?.reason ||
    lensEvent.threadState?.providerThreadId ||
    lensEvent.turnId ||
    'No detail'
  ).trim();
}

function summarizeEventDetail(lensEvent: LensPulseEvent): string {
  return (
    lensEvent.raw?.method ||
    lensEvent.item?.detail ||
    lensEvent.requestOpened?.requestTypeLabel ||
    lensEvent.sessionState?.stateLabel ||
    lensEvent.threadState?.stateLabel ||
    lensEvent.turnStarted?.model ||
    lensEvent.turnCompleted?.stateLabel ||
    lensEvent.contentDelta?.streamKind ||
    lensEvent.requestId ||
    lensEvent.itemId ||
    'Lens runtime event'
  );
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

function transcriptKindFromStream(streamKind: string): TranscriptKind {
  const normalized = streamKind.toLowerCase();
  if (normalized === 'assistant_text') {
    return 'assistant';
  }
  if (normalized === 'reasoning_text' || normalized === 'reasoning_summary_text') {
    return 'system';
  }
  if (normalized === 'command_output' || normalized === 'file_change_output') {
    return 'tool';
  }
  return 'system';
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

function failedCopy(state: SessionLensViewState): string {
  return state.activationState === 'failed'
    ? 'Lens could not complete its startup sequence.'
    : 'Waiting for mtagenthost, provider attach, and the first canonical snapshot.';
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
