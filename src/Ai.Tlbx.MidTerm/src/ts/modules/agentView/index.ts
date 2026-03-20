import { t } from '../i18n';
import { createLogger } from '../logging';
import { onTabActivated, onTabDeactivated, switchTab } from '../sessionTabs';
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
  type LensPulseSnapshotResponse,
  type LensPulseItemSummary,
  type LensPulseRuntimeNotice,
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

  try {
    await attachSessionLens(sessionId);
    const [snapshot, eventFeed] = await Promise.all([
      getLensSnapshot(sessionId),
      getLensEvents(sessionId),
    ]);
    state.snapshot = snapshot;
    state.events = eventFeed.events.slice(-60);
    state.streamConnected = false;
    renderCurrentAgentView(sessionId);
    openLiveLensStream(sessionId, snapshot.latestSequence);
  } catch (error) {
    log.warn(() => `Failed to activate Lens for ${sessionId}: ${String(error)}`);
    renderUnavailable(state.panel, t('agentView.loadError'));
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
      <div class="agent-view-grid">
        <div class="agent-view-column">
          <article class="agent-card-grid">
            <section class="agent-card">
              <div class="agent-card-label">Session</div>
              <div class="agent-card-value" data-agent-field="session-state"></div>
              <div class="agent-card-meta" data-agent-field="session-meta"></div>
            </section>
            <section class="agent-card">
              <div class="agent-card-label">Thread</div>
              <div class="agent-card-value" data-agent-field="thread-state"></div>
              <div class="agent-card-meta" data-agent-field="thread-meta"></div>
            </section>
            <section class="agent-card">
              <div class="agent-card-label">Turn</div>
              <div class="agent-card-value" data-agent-field="turn-state"></div>
              <div class="agent-card-meta" data-agent-field="turn-meta"></div>
            </section>
            <section class="agent-card">
              <div class="agent-card-label">Requests</div>
              <div class="agent-card-value" data-agent-field="request-state"></div>
              <div class="agent-card-meta" data-agent-field="request-meta"></div>
            </section>
          </article>
          <section class="agent-card agent-card-wide">
            <div class="agent-card-header">
              <div>
                <div class="agent-card-label">Requests</div>
                <div class="agent-card-meta">Approvals and user-input prompts from the runtime.</div>
              </div>
            </div>
            <div class="agent-activity-list" data-agent-field="requests"></div>
          </section>
          <section class="agent-card agent-card-wide">
            <div class="agent-card-header">
              <div>
                <div class="agent-card-label">Items</div>
                <div class="agent-card-meta">Tool calls and message lifecycle from the canonical Lens stream.</div>
              </div>
            </div>
            <div class="agent-activity-list" data-agent-field="items"></div>
          </section>
          <section class="agent-card agent-card-wide">
            <div class="agent-card-header">
              <div>
                <div class="agent-card-label">Timeline</div>
                <div class="agent-card-meta">Latest canonical Lens events.</div>
              </div>
            </div>
            <div class="agent-activity-list" data-agent-field="events"></div>
          </section>
        </div>
        <div class="agent-view-column">
          <section class="agent-card agent-card-wide agent-output-card">
            <div class="agent-card-header">
              <div>
                <div class="agent-card-label">Assistant Output</div>
                <div class="agent-card-meta">Assistant text reconstructed by the backend reducer.</div>
              </div>
            </div>
            <pre class="agent-output" data-agent-field="assistant-output"></pre>
          </section>
          <section class="agent-card agent-card-wide">
            <div class="agent-card-header">
              <div>
                <div class="agent-card-label">Reasoning</div>
                <div class="agent-card-meta">Reasoning and summaries when the provider emits them.</div>
              </div>
            </div>
            <pre class="agent-output" data-agent-field="reasoning-output"></pre>
          </section>
          <section class="agent-card agent-card-wide">
            <div class="agent-card-header">
              <div>
                <div class="agent-card-label">Plan</div>
                <div class="agent-card-meta">Structured plan/proposed-plan data from the runtime.</div>
              </div>
            </div>
            <pre class="agent-output" data-agent-field="plan-output"></pre>
          </section>
          <section class="agent-card agent-card-wide">
            <div class="agent-card-header">
              <div>
                <div class="agent-card-label">Tool Output</div>
                <div class="agent-card-meta">Command and file-change output streams.</div>
              </div>
            </div>
            <pre class="agent-output" data-agent-field="tool-output"></pre>
          </section>
          <section class="agent-card agent-card-wide">
            <div class="agent-card-header">
              <div>
                <div class="agent-card-label">Diff</div>
                <div class="agent-card-meta">Latest unified diff from the canonical Lens stream.</div>
              </div>
            </div>
            <pre class="agent-output" data-agent-field="diff-output"></pre>
          </section>
          <section class="agent-card agent-card-wide">
            <div class="agent-card-header">
              <div>
                <div class="agent-card-label">Runtime Notices</div>
                <div class="agent-card-meta">Warnings and errors emitted by the native harness.</div>
              </div>
            </div>
            <div class="agent-activity-list" data-agent-field="notices"></div>
          </section>
        </div>
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
      renderCurrentAgentView(sessionId);
    },
    onEvent: (lensEvent) => {
      const current = viewStates.get(sessionId);
      if (!current) {
        return;
      }

      current.events = [...current.events, lensEvent].slice(-60);
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
  if (!state) {
    return;
  }

  if (state.refreshScheduled !== null) {
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
    renderCurrentAgentView(sessionId);
  } catch (error) {
    log.warn(() => `Failed to refresh Lens snapshot for ${sessionId}: ${String(error)}`);
    renderUnavailable(state.panel, t('agentView.loadError'));
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
    renderUnavailable(state.panel, 'Lens snapshot pending.');
    return;
  }

  renderAgentView(state.panel, state.snapshot, state.events, state.streamConnected, state);
}

function renderUnavailable(panel: HTMLDivElement, message: string): void {
  panel.dataset.agentTurnId = '';
  setText(panel, 'title', t('agentView.unavailableTitle'));
  setText(panel, 'subtitle', message);
  setText(panel, 'session-state', t('agentView.unavailableTitle'));
  setText(panel, 'session-meta', message);
  setText(panel, 'thread-state', t('agentView.unavailableTitle'));
  setText(panel, 'thread-meta', message);
  setText(panel, 'turn-state', t('agentView.unavailableTitle'));
  setText(panel, 'turn-meta', message);
  setText(panel, 'request-state', '0');
  setText(panel, 'request-meta', message);
  clearContainer(panel, 'chips');
  renderOutput(panel, 'assistant-output', message);
  renderOutput(panel, 'reasoning-output', message);
  renderOutput(panel, 'plan-output', message);
  renderOutput(panel, 'tool-output', message);
  renderOutput(panel, 'diff-output', message);
  renderEmptyList(panel, 'requests', message);
  renderEmptyList(panel, 'items', message);
  renderEmptyList(panel, 'events', message);
  renderEmptyList(panel, 'notices', message);
  const interruptButton = panel.querySelector<HTMLButtonElement>('[data-agent-action="interrupt"]');
  if (interruptButton) {
    interruptButton.hidden = true;
    interruptButton.disabled = false;
    interruptButton.textContent = 'Stop turn';
  }
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
    'session-state',
    snapshot.session.stateLabel || prettify(snapshot.session.state || 'unknown'),
  );
  setText(
    panel,
    'session-meta',
    snapshot.session.lastEventAt
      ? `Last event ${formatAbsoluteTime(snapshot.session.lastEventAt)}`
      : snapshot.session.reason || 'No session updates yet.',
  );
  setText(
    panel,
    'thread-state',
    snapshot.thread.stateLabel || prettify(snapshot.thread.state || 'unknown'),
  );
  setText(panel, 'thread-meta', snapshot.thread.threadId || 'Provider thread pending');
  setText(panel, 'turn-state', summarizeTurnState(snapshot));
  setText(panel, 'turn-meta', summarizeTurnMeta(snapshot));
  setText(panel, 'request-state', `${openRequests.length}/${snapshot.requests.length}`);
  setText(
    panel,
    'request-meta',
    openRequests[0]?.kindLabel ?? latestNotice?.message ?? 'No open requests.',
  );

  panel.dataset.agentTurnId = snapshot.currentTurn.turnId || '';
  syncInterruptAction(panel, snapshot, state.interruptPending);
  renderChips(panel, snapshot, latestNotice !== null, streamConnected);
  renderRequests(panel, snapshot.sessionId, snapshot.requests, state.requestBusyIds);
  renderItems(panel, snapshot.items);
  renderEvents(panel, events);
  renderNotices(panel, snapshot.notices);
  renderOutput(
    panel,
    'assistant-output',
    snapshot.streams.assistantText,
    'No assistant output yet.',
  );
  renderOutput(
    panel,
    'reasoning-output',
    [snapshot.streams.reasoningSummaryText, snapshot.streams.reasoningText]
      .filter(Boolean)
      .join('\n\n'),
    'No reasoning stream yet.',
  );
  renderOutput(panel, 'plan-output', snapshot.streams.planText, 'No plan stream yet.');
  renderOutput(
    panel,
    'tool-output',
    [snapshot.streams.commandOutput, snapshot.streams.fileChangeOutput]
      .filter(Boolean)
      .join('\n\n'),
    'No tool output yet.',
  );
  renderOutput(panel, 'diff-output', snapshot.streams.unifiedDiff, 'No diff stream yet.');
}

function renderChips(
  panel: HTMLDivElement,
  snapshot: LensPulseSnapshotResponse,
  hasRuntimeNotice: boolean,
  streamConnected: boolean,
): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="chips"]');
  if (!container) {
    return;
  }

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

function renderRequests(
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
    renderEmptyContainer(container, 'No requests yet.');
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const request of requests.slice(0, 12)) {
    fragment.appendChild(
      createRequestItem(sessionId, request, busyRequestIds.has(request.requestId)),
    );
  }

  container.replaceChildren(fragment);
}

function renderItems(panel: HTMLDivElement, items: LensPulseItemSummary[]): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="items"]');
  if (!container) {
    return;
  }

  if (items.length === 0) {
    renderEmptyContainer(container, 'No items yet.');
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items.slice(0, 16)) {
    fragment.appendChild(
      createActivityItem(
        toneFromState(item.status),
        `${prettify(item.itemType)} • ${formatAbsoluteTime(item.updatedAt)}`,
        item.title || prettify(item.itemType),
        item.detail || item.turnId || 'No detail',
      ),
    );
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
  for (const lensEvent of [...events].slice(-20).reverse()) {
    const summary = summarizeEvent(lensEvent);
    const detail = summarizeEventDetail(lensEvent);
    fragment.appendChild(
      createActivityItem(
        toneFromEvent(lensEvent.type),
        `${lensEvent.type} • ${formatAbsoluteTime(lensEvent.createdAt)}`,
        summary,
        detail,
      ),
    );
  }

  container.replaceChildren(fragment);
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
      createActivityItem(
        notice.type === 'runtime.error' ? 'attention' : 'warning',
        `${notice.type} • ${formatAbsoluteTime(notice.createdAt)}`,
        notice.message,
        notice.detail || 'No extra detail',
      ),
    );
  }

  container.replaceChildren(fragment);
}

function createActivityItem(
  tone: string,
  metaText: string,
  summaryText: string,
  detailText: string,
): HTMLElement {
  const item = document.createElement('article');
  item.className = `agent-activity-item agent-activity-${tone.replace(/[^a-z0-9-]/gi, '-')}`;

  const meta = document.createElement('div');
  meta.className = 'agent-activity-meta';
  meta.textContent = metaText;

  const summary = document.createElement('div');
  summary.className = 'agent-activity-summary';
  summary.textContent = summaryText;

  const detail = document.createElement('div');
  detail.className = 'agent-activity-detail';
  detail.textContent = detailText;

  item.appendChild(meta);
  item.appendChild(summary);
  item.appendChild(detail);
  return item;
}

function createRequestItem(
  sessionId: string,
  request: LensPulseRequestSummary,
  busy: boolean,
): HTMLElement {
  const item = createActivityItem(
    request.state === 'resolved' ? 'positive' : 'warning',
    `${request.kindLabel} • ${formatAbsoluteTime(request.updatedAt)}`,
    request.detail || summarizeRequest(request),
    request.state === 'resolved' && request.decision
      ? `Resolved as ${request.decision}`
      : request.state === 'resolved'
        ? 'Resolved'
        : 'Open',
  );

  if (request.state === 'resolved') {
    return item;
  }

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
  } else {
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

    actions.appendChild(approve);
    actions.appendChild(decline);
  }

  item.appendChild(actions);
  return item;
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

function renderOutput(
  panel: HTMLDivElement,
  field: string,
  text: string | null | undefined,
  empty = 'No data yet.',
): void {
  const element = panel.querySelector<HTMLElement>(`[data-agent-field="${field}"]`);
  if (!element) {
    return;
  }

  const normalized = text?.trimEnd();
  element.textContent = normalized && normalized.length > 0 ? normalized : empty;
}

function renderEmptyList(panel: HTMLDivElement, field: string, text: string): void {
  const container = panel.querySelector<HTMLElement>(`[data-agent-field="${field}"]`);
  if (!container) {
    return;
  }

  renderEmptyContainer(container, text);
}

function renderEmptyContainer(container: HTMLElement, text: string): void {
  const empty = document.createElement('div');
  empty.className = 'agent-activity-empty';
  empty.textContent = text;
  container.replaceChildren(empty);
}

function clearContainer(panel: HTMLDivElement, field: string): void {
  panel.querySelector<HTMLElement>(`[data-agent-field="${field}"]`)?.replaceChildren();
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
  } finally {
    state.requestBusyIds.delete(requestId);
    renderCurrentAgentView(sessionId);
  }
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

function summarizeRequest(request: LensPulseRequestSummary): string {
  if (request.questions.length > 0) {
    return request.questions.map((question) => question.question).join(' • ');
  }

  if (request.answers.length > 0) {
    return request.answers
      .map((answer) => `${answer.questionId}: ${answer.answers.join(', ')}`)
      .join(' • ');
  }

  return request.turnId || 'No detail';
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

function toneFromEvent(eventType: string): string {
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

function toneFromState(state: string | null | undefined): string {
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
