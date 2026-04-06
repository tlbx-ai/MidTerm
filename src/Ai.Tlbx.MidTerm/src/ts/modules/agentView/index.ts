import { createLogger } from '../logging';
import { buildLensDebugScenario, type LensDebugScenarioName } from './debugScenario';
import {
  appendActivationTrace,
  classifyLensActivationIssue,
  describeError,
  ensureLensActivationIsCurrent,
  isStaleLensActivationError,
  normalizeLensProvider,
  resolveLensLayoutMode,
  setActivationState,
  shouldShowLensDevErrorDialog,
} from './activationHelpers';
import type {
  AssistantMarkdownCacheEntry,
  HistoryRenderedNode,
  HistoryScrollMetrics,
  HistoryVirtualWindow,
  LensHistoryEntry,
  SessionLensViewState,
} from './types';
import { estimateHistoryEntryHeight } from './historyContent';
import {
  applyOptimisticLensTurns,
  buildActivationHistoryEntries,
  buildLensHistoryEntries,
  buildLensRuntimeStats,
  cloneHistoryAttachments,
  syncBusyIndicatorTicker,
  withActivationIssueNotice,
  withInlineLensStatus,
  withLiveAssistantState,
  withTrailingBusyIndicator,
  withTurnDurationNotes,
} from './historyProcessing';
import {
  applyCanonicalLensDelta,
  applyLensSnapshotWindowState,
  collapseSnapshotToLatestWindow,
} from './snapshotState';
import { createAgentHistoryDom } from './historyDom';
import { createAgentHistoryRender } from './historyRender';
import {
  ensureAgentViewSkeleton,
  LENS_DEBUG_SCENARIO_NAMES,
  normalizeLensDebugScenarioName,
} from './viewShell';
import { buildTerminalFontStack, getConfiguredTerminalFontFamily } from '../terminal/fontConfig';
import {
  ensureSessionWrapper,
  getActiveTab,
  getTabPanel,
  onTabActivated,
  onTabDeactivated,
  setSessionLensAvailability,
  switchTab,
} from '../sessionTabs';
import {
  clearLensTurnSessionState,
  handleLensEscape,
  LENS_TURN_ACCEPTED_EVENT,
  LENS_TURN_FAILED_EVENT,
  LENS_TURN_SUBMITTED_EVENT,
  syncLensTurnExecutionState,
  type LensTurnAcceptedEventDetail,
  type LensTurnFailedEventDetail,
  type LensTurnSubmittedEventDetail,
} from '../lens/input';
import {
  removeLensQuickSettingsSessionState,
  syncLensQuickSettingsFromSnapshot,
} from '../lens/quickSettings';
import { showDevErrorDialog } from '../../utils/devErrorDialog';
import {
  attachSessionLens,
  detachSessionLens,
  getLensSnapshot,
  openLensEventStream,
  type LensPulseEvent,
  type LensPulseSnapshotResponse,
} from '../../api/client';
import { t } from '../i18n';
import { $activeSessionId } from '../../stores';

const log = createLogger('agentView');
const viewStates = new Map<string, SessionLensViewState>();
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;
const HISTORY_OVERSCAN_PX = 800;
const HISTORY_VIRTUALIZE_AFTER = 50;
const LENS_HISTORY_WINDOW_SIZE = 80;
const LENS_HISTORY_PAGE_SIZE = 40;
const LENS_HISTORY_FETCH_THRESHOLD_PX = 240;
const USER_HISTORY_SCROLL_INTENT_WINDOW_MS = 900;
let lensTurnLifecycleBound = false;
let lensActiveSessionBound = false;
let lensSelectionGuardBound = false;

const historyDom = createAgentHistoryDom({
  getState: (sessionId) => viewStates.get(sessionId),
  refreshLensSnapshot,
  renderCurrentAgentView: (sessionId) => {
    renderCurrentAgentView(sessionId);
  },
  retryLensActivation,
  logWarn: log.warn.bind(log),
});
const historyRender = createAgentHistoryRender({
  getState: (sessionId) => viewStates.get(sessionId),
  scheduleHistoryRender,
  syncAgentViewPresentation,
  createHistoryEntry: historyDom.createHistoryEntry,
  createHistorySpacer: historyDom.createHistorySpacer,
  createRequestActionBlock: historyDom.createRequestActionBlock,
  pruneAssistantMarkdownCache: historyDom.pruneAssistantMarkdownCache,
  renderRuntimeStats: historyDom.renderRuntimeStats,
});

function lensText(key: string, fallback: string): string {
  const translated = t(key);
  if (!translated || translated === key) {
    return fallback;
  }

  return translated;
}

function lensFormat(
  key: string,
  fallback: string,
  replacements: Record<string, string | number>,
): string {
  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
    lensText(key, fallback),
  );
}

/**
 * Wires Lens into the session-tab shell so supported agent sessions can open a
 * conversation-first surface without changing MidTerm's terminal-owned runtime
 * model underneath.
 */
export function initAgentView(): void {
  bindLensTurnLifecycle();
  bindActiveLensSessionRendering();
  bindLensSelectionGuard();
  onTabActivated('agent', (sessionId, panel) => {
    ensureAgentViewSkeleton(sessionId, panel, (targetSessionId) => {
      void handleLensEscape(targetSessionId);
    });
    const state = getOrCreateViewState(sessionId, panel);
    state.panel = panel;
    bindHistoryViewport(sessionId, state);
    void activateAgentView(sessionId);
  });

  onTabDeactivated('agent', (sessionId) => {
    const state = viewStates.get(sessionId);
    if (!state) {
      return;
    }

    state.historyAutoScrollPinned = true;
    releaseHiddenLensRenderState(state);
    void compactHiddenLensSessionHistory(sessionId, state);
  });

  log.info(() => 'Agent view initialized');
}

/**
 * Tears down per-session Lens state when a session closes or loses the Lens
 * surface so stale streams, timers, and attach state do not leak across turns.
 */
export function destroyAgentView(sessionId: string): void {
  closeLensStream(sessionId);
  void detachSessionLens(sessionId).catch((error: unknown) => {
    log.warn(() => `Failed to detach Lens for ${sessionId}: ${String(error)}`);
  });
  const state = viewStates.get(sessionId);
  if (state && state.historyRenderScheduled !== null) {
    window.cancelAnimationFrame(state.historyRenderScheduled);
  }
  if (state && state.busyIndicatorTickHandle !== null) {
    window.clearTimeout(state.busyIndicatorTickHandle);
  }
  state?.historyRenderedNodes.clear();
  if (state) {
    state.historyTopSpacer = null;
    state.historyBottomSpacer = null;
    state.historyEmptyState = null;
    state.historyExpandedEntries.clear();
  }

  viewStates.delete(sessionId);
  clearLensTurnSessionState(sessionId);
  removeLensQuickSettingsSessionState(sessionId);
}

export function resetAgentViewRuntimeForTests(): void {
  for (const [sessionId, state] of viewStates) {
    if (state.historyRenderScheduled !== null) {
      window.cancelAnimationFrame(state.historyRenderScheduled);
    }
    if (state.busyIndicatorTickHandle !== null) {
      window.clearTimeout(state.busyIndicatorTickHandle);
    }
    state.disconnectStream?.();
    clearLensTurnSessionState(sessionId);
    removeLensQuickSettingsSessionState(sessionId);
  }

  viewStates.clear();
  lensTurnLifecycleBound = false;
  lensActiveSessionBound = false;
  lensSelectionGuardBound = false;
}

/**
 * Exposes deterministic history fixtures so Lens UI work can be iterated
 * and regression-tested without depending on a live agent runtime.
 */
export function getLensDebugScenarioNames(): readonly LensDebugScenarioName[] {
  return LENS_DEBUG_SCENARIO_NAMES;
}

/**
 * Loads representative Lens history into an existing session panel to
 * speed up conversation UX and CSS tuning without depending on a live agent runtime.
 */
export function showLensDebugScenario(sessionId: string, scenario = 'mixed'): boolean {
  ensureSessionWrapper(sessionId);
  setSessionLensAvailability(sessionId, true);
  const panel = getTabPanel(sessionId, 'agent');
  if (!panel) {
    return false;
  }

  ensureAgentViewSkeleton(sessionId, panel, (targetSessionId) => {
    void handleLensEscape(targetSessionId);
  });
  const state = getOrCreateViewState(sessionId, panel);
  state.panel = panel;
  bindHistoryViewport(sessionId, state);

  const debugScenario = buildLensDebugScenario(
    sessionId,
    normalizeLensDebugScenarioName(scenario),
    window.location.origin,
  );
  state.snapshot = debugScenario.snapshot;
  state.events = debugScenario.events;
  state.debugScenarioActive = true;
  state.activationRunId += 1;
  state.streamConnected = true;
  state.refreshInFlight = false;
  state.activationState = 'ready';
  state.activationDetail = 'Lens debug scenario loaded.';
  state.activationTrace = [];
  state.activationError = null;
  state.activationIssue = null;
  state.activationActionBusy = false;
  state.requestBusyIds.clear();
  state.historyAutoScrollPinned = true;
  renderCurrentAgentView(sessionId);
  switchTab(sessionId, 'agent');
  return true;
}

async function activateAgentView(sessionId: string): Promise<void> {
  const state = viewStates.get(sessionId);
  if (!state) {
    return;
  }

  if (state.debugScenarioActive) {
    renderCurrentAgentView(sessionId);
    return;
  }

  if (state.snapshot && state.disconnectStream && state.streamConnected) {
    renderCurrentAgentView(sessionId, { immediate: true });
    return;
  }

  state.activationRunId += 1;
  const activationRunId = state.activationRunId;

  const hasExistingHistory = state.snapshot !== null || state.events.length > 0;
  if (hasExistingHistory) {
    await resumeLensFromHistory(sessionId, state, activationRunId);
    return;
  }

  state.snapshot = null;
  state.events = [];
  state.streamConnected = false;
  state.activationTrace = [];
  state.activationError = null;
  state.activationIssue = null;
  state.activationActionBusy = false;

  setActivationState(
    state,
    'opening',
    lensText('lens.activation.opening.detail', 'Lens pane opened. Preparing Lens runtime attach.'),
    lensText('lens.activation.opening.summary', 'Lens pane opened.'),
    lensText(
      'lens.activation.opening.body',
      'MidTerm is opening the Lens conversation surface for this session.',
    ),
  );
  setActivationState(
    state,
    'attaching',
    lensText('lens.activation.attaching.detail', 'Requesting Lens runtime attach.'),
    lensText('lens.activation.attaching.summary', 'Attaching Lens runtime.'),
    lensText(
      'lens.activation.attaching.body',
      'Starting or reconnecting the backend-owned Lens runtime for this session.',
    ),
  );
  renderCurrentAgentView(sessionId);

  const restoredReadonlyHistory = await tryLoadReadonlyLensHistory(
    sessionId,
    state,
    activationRunId,
  );
  ensureLensActivationIsCurrent(state, activationRunId);
  if (restoredReadonlyHistory) {
    renderCurrentAgentView(sessionId);
    await resumeLensFromHistory(sessionId, state, activationRunId);
    return;
  }

  try {
    await attachSessionLens(sessionId);
    ensureLensActivationIsCurrent(state, activationRunId);
    setActivationState(
      state,
      'waiting-snapshot',
      lensText(
        'lens.activation.waitingSnapshot.detail',
        'Lens runtime accepted the attach request.',
      ),
      lensText('lens.activation.waitingSnapshot.summary', 'Lens runtime attached.'),
      lensText(
        'lens.activation.waitingSnapshot.body',
        'Waiting for the first canonical Lens snapshot from MidTerm.',
      ),
    );
    renderCurrentAgentView(sessionId);

    const snapshot = await waitForInitialLensSnapshot(sessionId, state, activationRunId);
    ensureLensActivationIsCurrent(state, activationRunId);

    setActivationState(
      state,
      'connecting-stream',
      lensText(
        'lens.activation.connectingStream.detail',
        'Lens snapshot is ready. Connecting the live stream.',
      ),
      lensText('lens.activation.connectingStream.summary', 'Lens snapshot ready.'),
      lensText(
        'lens.activation.connectingStream.body',
        'Opening the live Lens stream so the history updates in real time.',
      ),
    );
    renderCurrentAgentView(sessionId);
    state.snapshot = snapshot;
    state.events = [];
    state.streamConnected = false;
    openLiveLensStream(sessionId, snapshot.latestSequence);
  } catch (error) {
    if (isStaleLensActivationError(error)) {
      return;
    }

    log.warn(() => `Failed to activate Lens for ${sessionId}: ${String(error)}`);
    const restoredFallbackHistory = await tryLoadReadonlyLensHistory(
      sessionId,
      state,
      activationRunId,
    );
    ensureLensActivationIsCurrent(state, activationRunId);
    if (restoredFallbackHistory) {
      log.warn(() => `Lens attach failed for ${sessionId}, but canonical history was restored.`);
      appendActivationTrace(
        state,
        'warning',
        'history-restored',
        lensText('lens.activation.historyRestored.summary', 'Canonical Lens history restored.'),
        lensText(
          'lens.activation.historyRestored.body',
          'MidTerm recovered canonical Lens history after the initial attach failed, so it is retrying the live attach automatically.',
        ),
      );
      await resumeLensFromHistory(sessionId, state, activationRunId);
      return;
    }

    state.activationError = describeError(error);
    state.activationIssue = classifyLensActivationIssue(error, false);
    setActivationState(
      state,
      'failed',
      lensText(
        'lens.activation.startupFailed.detail',
        'Lens startup failed before the first stable snapshot became available.',
      ),
      lensText('lens.activation.startupFailed.summary', 'Lens startup failed.'),
      state.activationError,
      'attention',
    );
    if (shouldShowLensDevErrorDialog(state.activationIssue)) {
      showDevErrorDialog({
        title: lensText('lens.error.openTitle', 'Lens failed to open'),
        context: `Lens activation failed for session ${sessionId}`,
        error,
      });
    }
    renderCurrentAgentView(sessionId);
  }
}

async function resumeLensFromHistory(
  sessionId: string,
  state: SessionLensViewState,
  activationRunId: number,
): Promise<void> {
  ensureLensActivationIsCurrent(state, activationRunId);
  state.streamConnected = false;
  renderCurrentAgentView(sessionId);

  try {
    await attachSessionLens(sessionId);
    ensureLensActivationIsCurrent(state, activationRunId);
    await refreshLensSnapshot(sessionId);
    ensureLensActivationIsCurrent(state, activationRunId);
    openLiveLensStream(sessionId, state.snapshot?.latestSequence ?? 0);
  } catch (error) {
    if (isStaleLensActivationError(error)) {
      return;
    }

    log.warn(() => `Failed to resume Lens for ${sessionId}: ${String(error)}`);
    state.activationError = describeError(error);
    state.activationIssue = classifyLensActivationIssue(error, true);
    renderCurrentAgentView(sessionId);
  }
}

async function tryLoadReadonlyLensHistory(
  sessionId: string,
  state: SessionLensViewState,
  activationRunId: number,
): Promise<boolean> {
  try {
    const snapshot = await getLensSnapshot(sessionId);
    applyLensSnapshotWindowState(state, snapshot);
    ensureLensActivationIsCurrent(state, activationRunId);
    const hasSnapshotHistory = hasRenderableLensHistory(snapshot);
    if (!hasSnapshotHistory) {
      return false;
    }

    state.snapshot = snapshot;
    state.events = [];
    state.streamConnected = false;
    state.activationTrace = [];
    return true;
  } catch (error) {
    log.warn(() => `Failed to load Lens snapshot fallback for ${sessionId}: ${String(error)}`);
    return false;
  }
}

function hasRenderableLensHistory(snapshot: LensPulseSnapshotResponse | null | undefined): boolean {
  if (!snapshot) {
    return false;
  }

  return (
    snapshot.latestSequence > 0 ||
    buildLensHistoryEntries(snapshot, []).length > 0 ||
    snapshot.items.length > 0 ||
    snapshot.requests.length > 0 ||
    Boolean(snapshot.streams.assistantText.trim()) ||
    Boolean(snapshot.streams.reasoningText.trim()) ||
    Boolean(snapshot.streams.reasoningSummaryText.trim()) ||
    Boolean(snapshot.streams.planText.trim()) ||
    Boolean(snapshot.streams.commandOutput.trim()) ||
    Boolean(snapshot.streams.fileChangeOutput.trim()) ||
    Boolean(snapshot.streams.unifiedDiff.trim())
  );
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
    debugScenarioActive: false,
    activationRunId: 0,
    historyViewport: null,
    historyEntries: [],
    historyWindowStart: 0,
    historyWindowCount: LENS_HISTORY_WINDOW_SIZE,
    disconnectStream: null,
    streamConnected: false,
    refreshInFlight: false,
    requestBusyIds: new Set<string>(),
    requestDraftAnswersById: {},
    requestQuestionIndexById: {},
    historyAutoScrollPinned: true,
    historyLastScrollMetrics: null,
    historyLastUserScrollIntentAt: 0,
    historyRenderScheduled: null,
    activationState: 'idle',
    activationDetail: '',
    activationTrace: [],
    activationError: null,
    activationIssue: null,
    activationActionBusy: false,
    optimisticTurns: [],
    renderDirty: false,
    assistantMarkdownCache: new Map<string, AssistantMarkdownCacheEntry>(),
    historyRenderedNodes: new Map<string, HistoryRenderedNode>(),
    historyTopSpacer: null,
    historyBottomSpacer: null,
    historyEmptyState: null,
    pendingHistoryPrependOffsetPx: 0,
    historyExpandedEntries: new Set<string>(),
    runtimeStats: null,
    busyIndicatorTickHandle: null,
    completedTurnDurationEntries: new Map<string, LensHistoryEntry>(),
  };

  viewStates.set(sessionId, created);
  return created;
}

function syncAgentViewPresentation(
  panel: HTMLDivElement,
  provider: string | null | undefined = null,
): void {
  const style = (panel as unknown as { style?: CSSStyleDeclaration | null }).style;
  if (!style || typeof style.setProperty !== 'function') {
    panel.dataset.lensProvider = normalizeLensProvider(provider);
    panel.dataset.lensLayout = resolveLensLayoutMode(provider);
    return;
  }

  style.setProperty(
    '--agent-history-mono-font-family',
    buildTerminalFontStack(getConfiguredTerminalFontFamily()),
  );
  panel.dataset.lensProvider = normalizeLensProvider(provider);
  panel.dataset.lensLayout = resolveLensLayoutMode(provider);
}

function bindHistoryViewport(sessionId: string, state: SessionLensViewState): void {
  const viewport = state.panel.querySelector<HTMLDivElement>('[data-agent-field="history"]');
  state.historyViewport = viewport;
  if (!viewport || viewport.dataset.lensScrollBound === 'true') {
    return;
  }

  viewport.dataset.lensScrollBound = 'true';
  const markUserScrollIntent = () => {
    const current = viewStates.get(sessionId);
    if (!current) {
      return;
    }

    current.historyLastUserScrollIntentAt = Date.now();
  };
  viewport.addEventListener('wheel', markUserScrollIntent, { passive: true });
  viewport.addEventListener('touchstart', markUserScrollIntent, { passive: true });
  viewport.addEventListener('pointerdown', markUserScrollIntent, { passive: true });
  viewport.addEventListener('keydown', markUserScrollIntent);
  viewport.addEventListener('scroll', () => {
    const current = viewStates.get(sessionId);
    const currentViewport = current?.historyViewport;
    if (!current || !currentViewport) {
      return;
    }

    const scrollMetrics = historyRender.readHistoryScrollMetrics(currentViewport);
    current.historyAutoScrollPinned = resolveHistoryAutoScrollPinned({
      wasPinned: current.historyAutoScrollPinned,
      previous: current.historyLastScrollMetrics,
      current: scrollMetrics,
      userInitiated:
        Date.now() - current.historyLastUserScrollIntentAt <= USER_HISTORY_SCROLL_INTENT_WINDOW_MS,
    });
    current.historyLastScrollMetrics = scrollMetrics;
    historyRender.renderScrollToBottomControl(current.panel, current);

    if (
      current.snapshot?.hasOlderHistory &&
      currentViewport.scrollTop <= LENS_HISTORY_FETCH_THRESHOLD_PX
    ) {
      void loadOlderLensHistoryWindow(sessionId, current);
    }

    if (current.snapshot?.hasNewerHistory && current.historyAutoScrollPinned) {
      void loadLatestLensHistoryWindow(sessionId, current);
    }

    if (current.historyEntries.length > HISTORY_VIRTUALIZE_AFTER) {
      scheduleHistoryRender(sessionId);
    }
  });

  const scrollButton = state.panel.querySelector<HTMLButtonElement>(
    '[data-agent-field="scroll-to-bottom"]',
  );
  if (scrollButton && scrollButton.dataset.lensScrollBound !== 'true') {
    scrollButton.dataset.lensScrollBound = 'true';
    scrollButton.addEventListener('click', () => {
      historyRender.scrollHistoryToBottom(sessionId, 'smooth');
    });
  }
}

function scheduleHistoryRender(sessionId: string): void {
  renderCurrentAgentView(sessionId);
}

function openLiveLensStream(sessionId: string, afterSequence: number): void {
  const state = viewStates.get(sessionId);
  if (!state) {
    return;
  }

  closeLensStream(sessionId);
  state.disconnectStream = openLensEventStream(
    sessionId,
    afterSequence,
    state.historyWindowStart,
    state.historyWindowCount,
    {
      onOpen: () => {
        const current = viewStates.get(sessionId);
        if (!current) {
          return;
        }

        current.streamConnected = true;
        current.activationIssue = null;
        current.activationError = null;
        setActivationState(
          current,
          'ready',
          lensText('lens.activation.ready.detail', 'Lens live stream connected.'),
          lensText('lens.activation.ready.summary', 'Live Lens stream connected.'),
          lensText(
            'lens.activation.ready.body',
            'Realtime canonical Lens events are now flowing into the history.',
          ),
          'positive',
        );
        renderCurrentAgentView(sessionId);
      },
      onSnapshot: (snapshot) => {
        const current = viewStates.get(sessionId);
        if (!current) {
          return;
        }

        applyLensSnapshotWindowState(current, snapshot);
        current.snapshot = snapshot;
        scheduleHistoryRender(sessionId);
      },
      onDelta: (delta) => {
        const current = viewStates.get(sessionId);
        if (!current || !current.snapshot) {
          return;
        }

        applyCanonicalLensDelta(current, delta);
        scheduleHistoryRender(sessionId);
      },
      onError: () => {
        const current = viewStates.get(sessionId);
        if (!current) {
          return;
        }

        current.streamConnected = false;
        renderCurrentAgentView(sessionId);
      },
    },
  );
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

function releaseHiddenLensRenderState(state: SessionLensViewState): void {
  state.historyEntries = [];
  state.historyRenderedNodes.clear();
  state.assistantMarkdownCache.clear();
  state.historyTopSpacer = null;
  state.historyBottomSpacer = null;
  state.historyEmptyState = null;
  state.pendingHistoryPrependOffsetPx = 0;
  state.renderDirty = true;

  const historyHost = state.panel.querySelector<HTMLElement>('[data-agent-field="history"]');
  historyHost?.replaceChildren();
}

async function compactHiddenLensSessionHistory(
  sessionId: string,
  state: SessionLensViewState,
): Promise<void> {
  if (state.debugScenarioActive || state.refreshInFlight) {
    return;
  }

  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }

  const shouldRefreshLatestWindow =
    snapshot.hasNewerHistory ||
    snapshot.historyWindowStart > 0 ||
    state.historyWindowCount > LENS_HISTORY_WINDOW_SIZE ||
    snapshot.transcript.length > LENS_HISTORY_WINDOW_SIZE;

  if (shouldRefreshLatestWindow) {
    try {
      const latestSnapshot = await getLensSnapshot(sessionId, undefined, LENS_HISTORY_WINDOW_SIZE);
      const current = viewStates.get(sessionId);
      if (!current || current !== state) {
        return;
      }

      applyLensSnapshotWindowState(current, latestSnapshot);
      current.snapshot = latestSnapshot;
      return;
    } catch (error) {
      log.warn(() => `Failed to compact hidden Lens history for ${sessionId}: ${String(error)}`);
    }
  }

  collapseSnapshotToLatestWindow(state, LENS_HISTORY_WINDOW_SIZE);
}

async function refreshLensSnapshot(sessionId: string): Promise<void> {
  const state = viewStates.get(sessionId);
  if (!state || state.refreshInFlight) {
    return;
  }

  state.refreshInFlight = true;
  try {
    const nextSnapshot = await getLensSnapshot(
      sessionId,
      state.historyWindowStart,
      state.historyWindowCount,
    );
    applyLensSnapshotWindowState(state, nextSnapshot);
    state.snapshot = nextSnapshot;
    if (state.activationState !== 'ready') {
      setActivationState(
        state,
        'ready',
        'Lens snapshot refreshed.',
        'Lens snapshot refreshed.',
        'The Lens read model is available and the history is rendering live data.',
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
      title: lensText('lens.error.refreshTitle', 'Lens refresh failed'),
      context: `Lens snapshot refresh failed for session ${sessionId}`,
      error,
    });
    renderCurrentAgentView(sessionId);
  } finally {
    state.refreshInFlight = false;
  }
}

async function loadOlderLensHistoryWindow(
  sessionId: string,
  state: SessionLensViewState,
): Promise<void> {
  if (state.refreshInFlight || !state.snapshot?.hasOlderHistory) {
    return;
  }

  const nextStart = Math.max(0, state.historyWindowStart - LENS_HISTORY_PAGE_SIZE);
  const existingWindowStart = state.historyWindowStart;
  if (nextStart === existingWindowStart) {
    return;
  }

  state.refreshInFlight = true;
  try {
    const nextWindowCount = state.historyWindowCount + (existingWindowStart - nextStart);
    const nextSnapshot = await getLensSnapshot(sessionId, nextStart, nextWindowCount);
    const nextWindowStart = nextSnapshot.historyWindowStart;
    const prependedEntries = nextSnapshot.transcript.slice(
      0,
      Math.max(0, existingWindowStart - nextWindowStart),
    );
    const prependedHistoryEntries = buildLensHistoryEntries(
      {
        ...nextSnapshot,
        transcript: prependedEntries,
      },
      [],
    );
    state.pendingHistoryPrependOffsetPx = prependedHistoryEntries.reduce(
      (sum, entry) => sum + estimateHistoryEntryHeight(entry),
      0,
    );
    applyLensSnapshotWindowState(state, nextSnapshot);
    state.snapshot = nextSnapshot;
    renderCurrentAgentView(sessionId);
  } catch (error) {
    log.warn(() => `Failed to load older Lens history for ${sessionId}: ${String(error)}`);
  } finally {
    state.refreshInFlight = false;
  }
}

async function loadLatestLensHistoryWindow(
  sessionId: string,
  state: SessionLensViewState,
): Promise<void> {
  if (state.refreshInFlight || !state.snapshot?.hasNewerHistory) {
    return;
  }

  state.refreshInFlight = true;
  try {
    const nextSnapshot = await getLensSnapshot(sessionId, undefined, state.historyWindowCount);
    applyLensSnapshotWindowState(state, nextSnapshot);
    state.snapshot = nextSnapshot;
    renderCurrentAgentView(sessionId);
  } catch (error) {
    log.warn(() => `Failed to load latest Lens history for ${sessionId}: ${String(error)}`);
  } finally {
    state.refreshInFlight = false;
  }
}

function renderCurrentAgentView(
  sessionId: string,
  options: { immediate?: boolean; force?: boolean } = {},
): void {
  const state = viewStates.get(sessionId);
  if (!state) {
    return;
  }

  state.renderDirty = true;

  if (!options.force && !isLensViewVisible(sessionId, state)) {
    return;
  }

  if (!options.immediate) {
    if (state.historyRenderScheduled !== null) {
      return;
    }

    state.historyRenderScheduled = window.requestAnimationFrame(() => {
      const current = viewStates.get(sessionId);
      if (!current) {
        return;
      }

      current.historyRenderScheduled = null;
      commitAgentViewRender(sessionId, options.force === true);
    });
    return;
  }

  if (state.historyRenderScheduled !== null) {
    window.cancelAnimationFrame(state.historyRenderScheduled);
    state.historyRenderScheduled = null;
  }

  commitAgentViewRender(sessionId, options.force === true);
}

function commitAgentViewRender(sessionId: string, force = false): void {
  const state = viewStates.get(sessionId);
  if (!state) {
    return;
  }

  if (!force && !isLensViewVisible(sessionId, state)) {
    return;
  }

  if (!force && hasActiveLensSelectionInPanel(state.panel)) {
    state.renderDirty = true;
    return;
  }

  state.renderDirty = false;

  if (!state.snapshot) {
    historyRender.renderActivationView(
      sessionId,
      state.panel,
      state,
      withActivationIssueNotice(buildActivationHistoryEntries(state), state.activationIssue),
    );
    return;
  }

  renderAgentView(state.panel, state.snapshot, state.events, state.streamConnected, state);
}

function bindActiveLensSessionRendering(): void {
  if (lensActiveSessionBound) {
    return;
  }

  $activeSessionId.subscribe((sessionId) => {
    if (!sessionId) {
      return;
    }

    const state = viewStates.get(sessionId);
    if (!state || !state.renderDirty) {
      return;
    }

    renderCurrentAgentView(sessionId, { immediate: true });
  });
  lensActiveSessionBound = true;
}

function bindLensSelectionGuard(): void {
  if (
    lensSelectionGuardBound ||
    typeof document === 'undefined' ||
    typeof document.addEventListener !== 'function'
  ) {
    return;
  }

  document.addEventListener('selectionchange', () => {
    for (const [sessionId, state] of viewStates) {
      if (!state.renderDirty || !isLensViewVisible(sessionId, state)) {
        continue;
      }

      if (hasActiveLensSelectionInPanel(state.panel)) {
        continue;
      }

      renderCurrentAgentView(sessionId, { immediate: true });
    }
  });
  lensSelectionGuardBound = true;
}

function isLensViewVisible(sessionId: string, state: SessionLensViewState): boolean {
  if (state.debugScenarioActive) {
    return true;
  }

  if (getActiveTab(sessionId) !== 'agent') {
    return false;
  }

  const activeSessionId = $activeSessionId.get();
  return !activeSessionId || activeSessionId === sessionId;
}

function renderAgentView(
  panel: HTMLDivElement,
  snapshot: LensPulseSnapshotResponse,
  events: LensPulseEvent[],
  streamConnected: boolean,
  state: SessionLensViewState,
): void {
  syncLensQuickSettingsFromSnapshot(snapshot.sessionId, snapshot.provider, snapshot.quickSettings);
  syncAgentViewPresentation(panel, snapshot.provider);
  panel.dataset.agentTurnId = snapshot.currentTurn.turnId || '';
  syncLensTurnExecutionState(snapshot.sessionId, snapshot.currentTurn);
  historyRender.syncRequestInteractionState(state, snapshot.requests);
  const historyEntries = buildLensHistoryEntries(snapshot, events);
  const runtimeStats = buildLensRuntimeStats(snapshot);
  state.runtimeStats = runtimeStats;
  const visibleHistoryEntries = historyRender.suppressActiveComposerRequestEntries(
    historyEntries,
    snapshot.requests,
  );
  const optimistic = applyOptimisticLensTurns(
    snapshot,
    visibleHistoryEntries,
    state.optimisticTurns,
  );
  state.optimisticTurns = optimistic.optimisticTurns;
  const renderedEntries = stabilizeHistoryEntryOrder(
    withTurnDurationNotes(
      snapshot,
      withTrailingBusyIndicator(
        snapshot,
        withLiveAssistantState(
          snapshot,
          withActivationIssueNotice(
            withInlineLensStatus(snapshot, optimistic.entries, streamConnected),
            state.activationIssue,
          ),
        ),
        snapshot.requests,
      ),
      state,
    ),
  );
  syncBusyIndicatorTicker({
    snapshot,
    state,
    entries: renderedEntries,
    renderCurrentAgentView,
  });
  historyDom.renderRuntimeStats(panel, runtimeStats);
  historyRender.renderHistory(panel, renderedEntries, snapshot.sessionId);
  historyRender.renderComposerInterruption(panel, snapshot.sessionId, snapshot.requests, state);
}

function bindLensTurnLifecycle(): void {
  if (lensTurnLifecycleBound || typeof window === 'undefined') {
    return;
  }

  window.addEventListener(LENS_TURN_SUBMITTED_EVENT, handleLensTurnSubmitted as EventListener);
  window.addEventListener(LENS_TURN_ACCEPTED_EVENT, handleLensTurnAccepted as EventListener);
  window.addEventListener(LENS_TURN_FAILED_EVENT, handleLensTurnFailed as EventListener);
  lensTurnLifecycleBound = true;
}

function handleLensTurnSubmitted(event: Event): void {
  const detail = (event as CustomEvent<LensTurnSubmittedEventDetail>).detail;
  const state = viewStates.get(detail.sessionId);
  if (!state) {
    return;
  }

  state.optimisticTurns = [
    ...state.optimisticTurns.filter((turn) => turn.optimisticId !== detail.optimisticId),
    {
      optimisticId: detail.optimisticId,
      turnId: null,
      text: (detail.request.text ?? '').trim(),
      attachments: cloneHistoryAttachments(detail.request.attachments),
      submittedAt: new Date().toISOString(),
      status: 'submitted',
    },
  ];
  renderCurrentAgentView(detail.sessionId);
}

function handleLensTurnAccepted(event: Event): void {
  const detail = (event as CustomEvent<LensTurnAcceptedEventDetail>).detail;
  const state = viewStates.get(detail.sessionId);
  if (!state) {
    return;
  }

  state.optimisticTurns = state.optimisticTurns.map((turn) =>
    turn.optimisticId === detail.optimisticId
      ? {
          ...turn,
          turnId: detail.response.turnId || turn.turnId,
          status: 'accepted',
        }
      : turn,
  );
  state.activationIssue = null;
  state.activationError = null;

  if (!state.streamConnected) {
    openLiveLensStream(detail.sessionId, state.snapshot?.latestSequence ?? 0);
  }

  renderCurrentAgentView(detail.sessionId);
}

function handleLensTurnFailed(event: Event): void {
  const detail = (event as CustomEvent<LensTurnFailedEventDetail>).detail;
  const state = viewStates.get(detail.sessionId);
  if (!state) {
    return;
  }

  state.optimisticTurns = state.optimisticTurns.filter(
    (turn) => turn.optimisticId !== detail.optimisticId,
  );
  renderCurrentAgentView(detail.sessionId);
}

function stabilizeHistoryEntryOrder(entries: readonly LensHistoryEntry[]): LensHistoryEntry[] {
  return [...entries].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
}

/**
 * Protects the user's reading position during streaming turns so Lens only
 * auto-pins when they are effectively already following the live edge.
 */
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

export function resolveHistoryAutoScrollPinned(args: {
  wasPinned: boolean;
  previous: HistoryScrollMetrics | null;
  current: HistoryScrollMetrics;
  userInitiated: boolean;
}): boolean {
  const nearBottom = isScrollContainerNearBottom(args.current);

  if (args.userInitiated) {
    return nearBottom;
  }

  if (args.wasPinned) {
    return true;
  }

  return nearBottom;
}

/**
 * Virtualizes long histories across viewport sizes so Lens keeps a bounded
 * DOM even during extended agent runs.
 */
export function computeHistoryVirtualWindow(
  entries: ReadonlyArray<LensHistoryEntry>,
  scrollTop: number,
  clientHeight: number,
  clientWidth = typeof window === 'undefined' ? 960 : window.innerWidth,
): HistoryVirtualWindow {
  if (entries.length <= HISTORY_VIRTUALIZE_AFTER) {
    return {
      start: 0,
      end: entries.length,
      topSpacerPx: 0,
      bottomSpacerPx: 0,
    };
  }

  const targetTop = Math.max(0, scrollTop - HISTORY_OVERSCAN_PX);
  const targetBottom = scrollTop + clientHeight + HISTORY_OVERSCAN_PX;
  let cumulative = 0;
  let start = 0;
  let topSpacerPx = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }

    const height = estimateHistoryEntryHeight(entry, clientWidth);
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

    cumulative += estimateHistoryEntryHeight(entry, clientWidth);
    end += 1;
  }

  const totalHeight = entries.reduce(
    (sum, entry) => sum + estimateHistoryEntryHeight(entry, clientWidth),
    0,
  );

  return {
    start,
    end: Math.max(end, start + 1),
    topSpacerPx,
    bottomSpacerPx: Math.max(0, totalHeight - cumulative),
  };
}

export function hasActiveLensSelectionInPanel(
  panel: ParentNode | null | undefined,
  selection:
    | Pick<Selection, 'rangeCount' | 'isCollapsed' | 'getRangeAt'>
    | null
    | undefined = resolveCurrentSelection(),
): boolean {
  if (!panel || !selection || selection.isCollapsed || selection.rangeCount <= 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  const startNode = range.startContainer;
  const endNode = range.endContainer;
  return panel.contains(startNode) || panel.contains(endNode);
}

function resolveCurrentSelection(): Pick<
  Selection,
  'rangeCount' | 'isCollapsed' | 'getRangeAt'
> | null {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') {
    return null;
  }

  return window.getSelection();
}

export { classifyLensActivationIssue, resolveHistoryBadgeLabel } from './activationHelpers';
export {
  buildRenderedDiffLines,
  estimateHistoryEntryHeight,
  resolveHistoryBodyPresentation,
  tokenizeCommandText,
} from './historyContent';
export {
  applyOptimisticLensTurns,
  buildActivationHistoryEntries,
  buildLensHistoryEntries,
  buildLensRuntimeStats,
  formatHistoryMeta,
  formatLensTurnDuration,
  shouldHideStatusInMeta,
  withActivationIssueNotice,
  withLiveAssistantState,
  withTrailingBusyIndicator,
} from './historyProcessing';
export { suppressActiveComposerRequestEntries } from './historyRender';
export { applyCanonicalLensDelta } from './snapshotState';

async function waitForInitialLensSnapshot(
  sessionId: string,
  state: SessionLensViewState,
  activationRunId: number,
): Promise<LensPulseSnapshotResponse> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    ensureLensActivationIsCurrent(state, activationRunId);
    try {
      const snapshot = state.snapshot
        ? await getLensSnapshot(sessionId, state.historyWindowStart, state.historyWindowCount)
        : await getLensSnapshot(sessionId);
      applyLensSnapshotWindowState(state, snapshot);
      ensureLensActivationIsCurrent(state, activationRunId);
      if (attempt > 1) {
        appendActivationTrace(
          state,
          'positive',
          `snapshot retry ${attempt}`,
          lensText('lens.activation.snapshotReady.summary', 'Lens snapshot became available.'),
          lensFormat(
            'lens.activation.snapshotReady.body',
            'MidTerm produced the first canonical Lens snapshot on retry {attempt}.',
            { attempt },
          ),
        );
      }
      return snapshot;
    } catch (error) {
      if (isStaleLensActivationError(error)) {
        throw error;
      }
      lastError = error;
      appendActivationTrace(
        state,
        attempt === 12 ? 'attention' : 'warning',
        `snapshot retry ${attempt}`,
        lensText('lens.activation.snapshotPending', 'Lens snapshot not ready yet.'),
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

async function retryLensActivation(sessionId: string): Promise<void> {
  const state = viewStates.get(sessionId);
  if (!state || state.activationActionBusy) {
    return;
  }

  state.activationActionBusy = true;
  state.activationIssue = null;
  state.activationError = null;
  appendActivationTrace(
    state,
    'info',
    'retry',
    lensText('lens.activation.retry.summary', 'Retrying Lens attach.'),
    lensText(
      'lens.activation.retry.detail',
      'MidTerm is retrying the live Lens attach for this session.',
    ),
  );
  renderCurrentAgentView(sessionId);

  try {
    if (state.snapshot || state.events.length > 0) {
      state.activationRunId += 1;
      await resumeLensFromHistory(sessionId, state, state.activationRunId);
    } else {
      await activateAgentView(sessionId);
    }
  } finally {
    const current = viewStates.get(sessionId);
    if (current) {
      current.activationActionBusy = false;
      renderCurrentAgentView(sessionId);
    }
  }
}
