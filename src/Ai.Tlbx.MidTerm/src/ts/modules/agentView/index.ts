/* eslint-disable max-lines -- Lens activation/runtime orchestration remains consolidated here until the active path is split into smaller modules. */
import { createLogger } from '../logging';
import { buildLensDebugScenario, type LensDebugScenarioName } from './debugScenario';
import {
  appendActivationTrace,
  classifyLensActivationIssue,
  describeError,
  ensureLensActivationIsCurrent,
  isStaleLensActivationError,
  setActivationState,
  shouldShowLensDevErrorDialog,
} from './activationHelpers';
import type {
  AssistantMarkdownCacheEntry,
  HistoryRenderedNode,
  LensHistoryEntry,
  SessionLensViewState,
} from './types';
import {
  applyOptimisticLensTurns,
  buildActivationHistoryEntries,
  buildLensHistoryEntries,
  buildLensRuntimeStats,
  cloneHistoryAttachments,
  preservePersistentCommandEntries,
  syncBusyIndicatorTicker,
  withActivationIssueNotice,
  withInlineLensStatus,
  withLiveAssistantState,
  withTrailingBusyIndicator,
  withTurnDurationNotes,
} from './historyProcessing';
import {
  applyCanonicalLensDelta,
  applyLensHistoryWindowState,
  collapseSnapshotToLatestWindow,
} from './snapshotState';
import {
  hasActiveLensSelectionInPanel,
  resolveHistoryScrollMode,
  setHistoryScrollMode,
  stabilizeHistoryEntryOrder,
} from './historyViewport';
import { resolveHistoryWindowViewportWidth } from './historyMeasurements';
import { createAgentHistoryDom } from './historyDom';
import { createAgentHistoryRender } from './historyRender';
import { applyFetchedLensHistoryWindow, hasRenderableLensHistory } from './historyWindowState';
import {
  resetLensHistoryTrace,
  traceLensHistoryCompact,
  traceLensHistoryFetch,
  traceLensHistoryPush,
} from './historyTrace';
import { resolveViewportDrivenHistoryWindowCount } from './historyWindowSizing';
import { prepareLensForForeground, syncAgentViewPresentation } from './viewPresentation';
import {
  ensureAgentViewSkeleton,
  LENS_DEBUG_SCENARIO_NAMES,
  normalizeLensDebugScenarioName,
} from './viewShell';
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
  getLensHistoryWindow,
  openLensHistoryStream,
  updateLensHistoryStreamWindow,
  type LensHistorySnapshot,
} from '../../api/client';
import { t } from '../i18n';
import { $activeSessionId } from '../../stores';

const log = createLogger('agentView');
const viewStates = new Map<string, SessionLensViewState>();
const LENS_HISTORY_WINDOW_SIZE = 80;
const LENS_HISTORY_FETCH_THRESHOLD_PX = 240;
const LENS_HISTORY_RETENTION_MIN_MARGIN = 30;
const LENS_HISTORY_RETENTION_MAX_MARGIN = 70;
const USER_HISTORY_SCROLL_INTENT_WINDOW_MS = 900;
let lensTurnLifecycleBound = false;
let lensActiveSessionBound = false;
let lensSelectionGuardBound = false;
let lensForegroundRecoveryBound = false;
let lensForegroundRecoveryPending = false;

function createHistoryWindowRevision(sessionId: string): string {
  return `${sessionId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

function issueHistoryWindowRevision(sessionId: string, state: SessionLensViewState): string {
  const revision = createHistoryWindowRevision(sessionId);
  state.historyWindowRevision = revision;
  return revision;
}

function resolveRequestedHistoryViewportWidth(
  state: Pick<SessionLensViewState, 'historyViewport'> | null | undefined,
): number | undefined {
  return resolveHistoryWindowViewportWidth(state?.historyViewport);
}

function syncLiveHistoryWindowViewport(sessionId: string, state: SessionLensViewState): void {
  if (!state.disconnectStream) {
    return;
  }

  const viewportWidth = resolveRequestedHistoryViewportWidth(state);
  state.historyWindowViewportWidth = viewportWidth ?? state.historyWindowViewportWidth;
  if (state.historyWindowViewportWidth === null) {
    updateLensHistoryStreamWindow(
      sessionId,
      state.historyWindowStart,
      state.historyWindowCount,
      state.historyWindowRevision ?? undefined,
    );
    return;
  }

  updateLensHistoryStreamWindow(
    sessionId,
    state.historyWindowStart,
    state.historyWindowCount,
    state.historyWindowRevision ?? undefined,
    state.historyWindowViewportWidth,
  );
}

function requestLensHistoryWindow(
  sessionId: string,
  state: SessionLensViewState,
  startIndex: number | undefined,
  count: number | undefined,
  windowRevision: string,
): Promise<LensHistorySnapshot> {
  const viewportWidth = resolveRequestedHistoryViewportWidth(state);
  state.historyWindowViewportWidth = viewportWidth ?? state.historyWindowViewportWidth;
  return state.historyWindowViewportWidth === null
    ? getLensHistoryWindow(sessionId, startIndex, count, windowRevision)
    : getLensHistoryWindow(
        sessionId,
        startIndex,
        count,
        windowRevision,
        state.historyWindowViewportWidth,
      );
}

function connectLensHistoryStream(
  sessionId: string,
  state: SessionLensViewState,
  afterSequence: number,
  callbacks: Parameters<typeof openLensHistoryStream>[5],
): () => void {
  state.historyWindowViewportWidth =
    resolveRequestedHistoryViewportWidth(state) ?? state.historyWindowViewportWidth;
  return state.historyWindowViewportWidth === null
    ? openLensHistoryStream(
        sessionId,
        afterSequence,
        state.historyWindowStart,
        state.historyWindowCount,
        state.historyWindowRevision ?? issueHistoryWindowRevision(sessionId, state),
        callbacks,
      )
    : openLensHistoryStream(
        sessionId,
        afterSequence,
        state.historyWindowStart,
        state.historyWindowCount,
        state.historyWindowRevision ?? issueHistoryWindowRevision(sessionId, state),
        callbacks,
        state.historyWindowViewportWidth,
      );
}

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
  bindLensForegroundRecovery();
  onTabActivated('agent', (sessionId, panel) => {
    ensureAgentViewSkeleton(sessionId, panel, (targetSessionId) => {
      void handleLensEscape(targetSessionId);
    });
    const state = getOrCreateViewState(sessionId, panel);
    state.panel = panel;
    bindHistoryViewport(sessionId, state);
    prepareLensForForeground(state);
    void activateAgentView(sessionId);
  });

  onTabDeactivated('agent', (sessionId) => {
    const state = viewStates.get(sessionId);
    if (!state) {
      return;
    }

    setHistoryScrollMode(state, 'follow');
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
  state?.historyMeasurementObserver?.disconnect();
  state?.historyViewportResizeObserver?.disconnect();
  state?.historyRenderedNodes.clear();
  state?.historyObservedHeights.clear();
  if (state) {
    state.historyTopSpacer = null;
    state.historyBottomSpacer = null;
    state.historyEmptyState = null;
    state.historyExpandedEntries.clear();
  }

  viewStates.delete(sessionId);
  resetLensHistoryTrace(sessionId);
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
    state.historyMeasurementObserver?.disconnect();
    state.historyViewportResizeObserver?.disconnect();
    clearLensTurnSessionState(sessionId);
    removeLensQuickSettingsSessionState(sessionId);
  }

  viewStates.clear();
  resetLensHistoryTrace();
  lensTurnLifecycleBound = false;
  lensActiveSessionBound = false;
  lensSelectionGuardBound = false;
  lensForegroundRecoveryBound = false;
  lensForegroundRecoveryPending = false;
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
  state.historyWindowRevision = null;
  setHistoryScrollMode(state, 'follow');
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
    if (state.historyAutoScrollPinned && state.snapshot.hasNewerHistory) {
      void refreshLensSnapshot(sessionId, { latestWindow: true });
    }
    return;
  }

  state.activationRunId += 1;
  const activationRunId = state.activationRunId;

  const hasExistingHistory = state.snapshot !== null;
  if (hasExistingHistory) {
    await resumeLensFromHistory(sessionId, state, activationRunId);
    return;
  }

  state.snapshot = null;
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
      'waiting-history-window',
      lensText(
        'lens.activation.waitingSnapshot.detail',
        'Lens runtime accepted the attach request.',
      ),
      lensText('lens.activation.waitingSnapshot.summary', 'Lens runtime attached.'),
      lensText(
        'lens.activation.waitingSnapshot.body',
        'Waiting for the first canonical Lens history window from MidTerm.',
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
        'Lens history window is ready. Connecting the live stream.',
      ),
      lensText('lens.activation.connectingStream.summary', 'Lens history window ready.'),
      lensText(
        'lens.activation.connectingStream.body',
        'Opening the live Lens stream so the history updates in real time.',
      ),
    );
    renderCurrentAgentView(sessionId);
    state.snapshot = snapshot;
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
        'Lens startup failed before the first stable history window became available.',
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
    await refreshLensSnapshot(sessionId, { latestWindow: state.historyAutoScrollPinned });
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
    state.historyWindowTargetCount = resolveViewportDrivenHistoryWindowCount(
      state.historyViewport,
      LENS_HISTORY_RETENTION_MIN_MARGIN,
      LENS_HISTORY_RETENTION_MAX_MARGIN,
      LENS_HISTORY_WINDOW_SIZE,
      state.historyObservedHeights.values(),
    );
    const windowRevision = issueHistoryWindowRevision(sessionId, state);
    const snapshot = await requestLensHistoryWindow(
      sessionId,
      state,
      undefined,
      state.historyWindowTargetCount,
      windowRevision,
    );
    ensureLensActivationIsCurrent(state, activationRunId);
    const hasSnapshotHistory = hasRenderableLensHistory(snapshot);
    if (!hasSnapshotHistory) {
      return false;
    }

    applyFetchedLensHistoryWindow(sessionId, state, snapshot);
    state.streamConnected = false;
    state.activationTrace = [];
    return true;
  } catch (error) {
    log.warn(() => `Failed to load Lens history fallback for ${sessionId}: ${String(error)}`);
    return false;
  }
}

function getOrCreateViewState(sessionId: string, panel: HTMLDivElement): SessionLensViewState {
  const existing = viewStates.get(sessionId);
  if (existing) {
    return existing;
  }

  const initialHistoryWindowCount = resolveViewportDrivenHistoryWindowCount(
    panel.querySelector<HTMLDivElement>('[data-agent-field="history"]'),
    LENS_HISTORY_RETENTION_MIN_MARGIN,
    LENS_HISTORY_RETENTION_MAX_MARGIN,
    LENS_HISTORY_WINDOW_SIZE,
  );

  const created: SessionLensViewState = {
    panel,
    snapshot: null,
    debugScenarioActive: false,
    activationRunId: 0,
    historyViewport: null,
    historyEntries: [],
    historyWindowStart: 0,
    historyWindowCount: initialHistoryWindowCount,
    historyWindowTargetCount: initialHistoryWindowCount,
    disconnectStream: null,
    streamConnected: false,
    refreshInFlight: false,
    requestBusyIds: new Set<string>(),
    requestDraftAnswersById: {},
    requestQuestionIndexById: {},
    historyScrollMode: 'follow',
    historyAutoScrollPinned: true,
    historyLastScrollMetrics: null,
    historyLastUserScrollIntentAt: 0,
    historyWindowRevision: null,
    historyWindowViewportWidth: null,
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
    historyMeasuredHeights: new Map<string, number>(),
    historyObservedHeights: new Map<string, number>(),
    historyMeasuredHeightsByBucket: new Map<number, Map<string, number>>(),
    historyObservedHeightsByBucket: new Map<number, Map<string, number>>(),
    historyObservedHeightSamplesByBucket: new Map<number, Map<string, number[]>>(),
    historyMeasuredWidthBucket: 0,
    historyMeasurementObserver: null,
    historyViewportResizeObserver: null,
    historyViewportSize: null,
    historyTopSpacer: null,
    historyBottomSpacer: null,
    historyEmptyState: null,
    pendingHistoryPrependAnchor: null,
    pendingHistoryLayoutAnchor: null,
    historyLastVirtualWindowKey: null,
    historyExpandedEntries: new Set<string>(),
    runtimeStats: null,
    busyIndicatorTickHandle: null,
    completedTurnDurationEntries: new Map<string, LensHistoryEntry>(),
  };

  viewStates.set(sessionId, created);
  return created;
}

function bindHistoryViewport(sessionId: string, state: SessionLensViewState): void {
  const viewport = state.panel.querySelector<HTMLDivElement>('[data-agent-field="history"]');
  state.historyViewport = viewport;
  if (!viewport) {
    return;
  }

  state.historyViewportSize = {
    width: viewport.clientWidth,
    height: viewport.clientHeight,
  };
  if (typeof ResizeObserver === 'function') {
    state.historyViewportResizeObserver ??= new ResizeObserver(() => {
      const current = viewStates.get(sessionId);
      const currentViewport = current?.historyViewport;
      if (!current || !currentViewport) {
        return;
      }

      const nextSize = {
        width: currentViewport.clientWidth,
        height: currentViewport.clientHeight,
      };
      const previousSize = current.historyViewportSize;
      current.historyViewportSize = nextSize;
      if (
        previousSize &&
        previousSize.width === nextSize.width &&
        previousSize.height === nextSize.height
      ) {
        return;
      }

      if (
        !current.historyAutoScrollPinned &&
        current.pendingHistoryPrependAnchor === null &&
        current.pendingHistoryLayoutAnchor === null
      ) {
        historyRender.captureHistoryViewportAnchor(current, 'pendingHistoryLayoutAnchor');
      }

      current.historyWindowTargetCount = resolveViewportDrivenHistoryWindowCount(
        currentViewport,
        LENS_HISTORY_RETENTION_MIN_MARGIN,
        LENS_HISTORY_RETENTION_MAX_MARGIN,
        Math.max(LENS_HISTORY_WINDOW_SIZE, current.historyWindowCount),
        current.historyObservedHeights.values(),
      );
      syncLiveHistoryWindowViewport(sessionId, current);
      scheduleHistoryRender(sessionId);
    });
    state.historyViewportResizeObserver.observe(viewport);
  }

  if (viewport.dataset.lensScrollBound === 'true') {
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
    setHistoryScrollMode(
      current,
      resolveHistoryScrollMode({
        previousMode: current.historyScrollMode,
        previous: current.historyLastScrollMetrics,
        current: scrollMetrics,
        userInitiated:
          Date.now() - current.historyLastUserScrollIntentAt <=
          USER_HISTORY_SCROLL_INTENT_WINDOW_MS,
        pendingAnchorRestore:
          current.pendingHistoryPrependAnchor !== null ||
          current.pendingHistoryLayoutAnchor !== null,
      }),
    );
    current.historyLastScrollMetrics = scrollMetrics;
    historyRender.renderScrollToBottomControl(current.panel, current);
    const fetchThresholdPx = Math.max(
      LENS_HISTORY_FETCH_THRESHOLD_PX,
      Math.round(currentViewport.clientHeight * 0.8),
    );
    const distanceFromBottom =
      currentViewport.scrollHeight - currentViewport.clientHeight - currentViewport.scrollTop;

    if (current.snapshot?.hasNewerHistory && distanceFromBottom <= fetchThresholdPx) {
      if (current.historyAutoScrollPinned) {
        void loadLatestLensHistoryWindow(sessionId, current);
      } else {
        void syncHistoryWindowToViewport(sessionId, current);
      }
    } else if (!current.historyAutoScrollPinned) {
      void syncHistoryWindowToViewport(sessionId, current);
    }

    if (historyRender.shouldRenderForViewportScroll(current)) {
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

function bindLensForegroundRecovery(): void {
  if (
    lensForegroundRecoveryBound ||
    typeof document === 'undefined' ||
    typeof document.addEventListener !== 'function' ||
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function'
  ) {
    return;
  }

  const recoverForegroundLensState = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }

    if (!lensForegroundRecoveryPending) {
      return;
    }

    lensForegroundRecoveryPending = false;
    const sessionId = $activeSessionId.get();
    if (!sessionId || getActiveTab(sessionId) !== 'agent') {
      return;
    }

    const state = viewStates.get(sessionId);
    if (!state) {
      return;
    }

    prepareLensForForeground(state);
    renderCurrentAgentView(sessionId, { immediate: true });
    if (state.snapshot) {
      void refreshLensSnapshot(sessionId, { latestWindow: true });
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      lensForegroundRecoveryPending = true;
      return;
    }

    recoverForegroundLensState();
  });
  window.addEventListener('blur', () => {
    lensForegroundRecoveryPending = true;
  });
  window.addEventListener('focus', recoverForegroundLensState);
  window.addEventListener('pageshow', recoverForegroundLensState);
  lensForegroundRecoveryBound = true;
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
  state.disconnectStream = connectLensHistoryStream(sessionId, state, afterSequence, {
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
          'Realtime canonical Lens history patches are now flowing into the timeline.',
        ),
        'positive',
      );
      renderCurrentAgentView(sessionId);
    },
    onHistoryWindow: (snapshot) => {
      const current = viewStates.get(sessionId);
      if (!current) {
        return;
      }

      traceLensHistoryFetch(sessionId, snapshot, 'stream-window');
      if (applyFetchedLensHistoryWindow(sessionId, current, snapshot)) {
        scheduleHistoryRender(sessionId);
      }
    },
    onPatch: (delta) => {
      const current = viewStates.get(sessionId);
      if (!current || !current.snapshot) {
        return;
      }

      traceLensHistoryPush(sessionId, delta, current.snapshot);
      const requiresWindowRefresh = applyCanonicalLensDelta(current, delta);
      scheduleHistoryRender(sessionId);
      if (requiresWindowRefresh) {
        void refreshLensSnapshot(sessionId);
      }
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

function releaseHiddenLensRenderState(state: SessionLensViewState): void {
  state.historyEntries = [];
  state.historyMeasurementObserver?.disconnect();
  state.historyRenderedNodes.clear();
  state.assistantMarkdownCache.clear();
  state.historyObservedHeights.clear();
  state.historyTopSpacer = null;
  state.historyBottomSpacer = null;
  state.historyEmptyState = null;
  state.pendingHistoryPrependAnchor = null;
  state.pendingHistoryLayoutAnchor = null;
  state.historyLastVirtualWindowKey = null;
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
    snapshot.history.length > LENS_HISTORY_WINDOW_SIZE;

  if (shouldRefreshLatestWindow) {
    try {
      const latestSnapshot = await getLensHistoryWindow(
        sessionId,
        undefined,
        resolveViewportDrivenHistoryWindowCount(
          state.historyViewport,
          LENS_HISTORY_RETENTION_MIN_MARGIN,
          LENS_HISTORY_RETENTION_MAX_MARGIN,
          LENS_HISTORY_WINDOW_SIZE,
          state.historyObservedHeights.values(),
        ),
        issueHistoryWindowRevision(sessionId, state),
      );
      traceLensHistoryFetch(sessionId, latestSnapshot, 'latest');
      const current = viewStates.get(sessionId);
      if (!current || current !== state) {
        return;
      }

      if (applyFetchedLensHistoryWindow(sessionId, current, latestSnapshot)) {
        if (isLensViewVisible(sessionId, current)) {
          renderCurrentAgentView(sessionId, { immediate: true });
        }
      }
      return;
    } catch (error) {
      log.warn(() => `Failed to compact hidden Lens history for ${sessionId}: ${String(error)}`);
    }
  }

  const previousStart = snapshot.historyWindowStart;
  const previousEnd = snapshot.historyWindowEnd;
  const historyCount = snapshot.historyCount;
  collapseSnapshotToLatestWindow(state, LENS_HISTORY_WINDOW_SIZE);
  traceLensHistoryCompact(
    sessionId,
    previousStart,
    previousEnd,
    state.historyWindowStart,
    state.historyWindowStart + state.historyWindowCount,
    historyCount,
  );
}

async function refreshLensSnapshot(
  sessionId: string,
  options: { latestWindow?: boolean } = {},
): Promise<void> {
  const state = viewStates.get(sessionId);
  if (!state || state.refreshInFlight) {
    return;
  }

  state.refreshInFlight = true;
  try {
    const desiredLatestWindowCount = resolveViewportDrivenHistoryWindowCount(
      state.historyViewport,
      LENS_HISTORY_RETENTION_MIN_MARGIN,
      LENS_HISTORY_RETENTION_MAX_MARGIN,
      Math.max(LENS_HISTORY_WINDOW_SIZE, state.historyWindowCount),
      state.historyObservedHeights.values(),
    );
    if (options.latestWindow) {
      state.historyWindowTargetCount = desiredLatestWindowCount;
    }
    const windowRevision = issueHistoryWindowRevision(sessionId, state);
    const nextSnapshot = options.latestWindow
      ? await requestLensHistoryWindow(
          sessionId,
          state,
          undefined,
          desiredLatestWindowCount,
          windowRevision,
        )
      : await requestLensHistoryWindow(
          sessionId,
          state,
          state.historyWindowStart,
          state.historyWindowCount,
          windowRevision,
        );
    traceLensHistoryFetch(sessionId, nextSnapshot, options.latestWindow ? 'latest' : 'refresh');
    if (applyFetchedLensHistoryWindow(sessionId, state, nextSnapshot)) {
      if (state.activationState !== 'ready') {
        setActivationState(
          state,
          'ready',
          'Lens history window refreshed.',
          'Lens history window refreshed.',
          'The Lens read model is available and the history is rendering live data.',
          'positive',
        );
      }
      renderCurrentAgentView(sessionId);
    }
  } catch (error) {
    log.warn(() => `Failed to refresh Lens history window for ${sessionId}: ${String(error)}`);
    state.activationError = describeError(error);
    setActivationState(
      state,
      'failed',
      'Lens history window refresh failed.',
      'Lens refresh failed.',
      state.activationError,
      'attention',
    );
    showDevErrorDialog({
      title: lensText('lens.error.refreshTitle', 'Lens refresh failed'),
      context: `Lens history window refresh failed for session ${sessionId}`,
      error,
    });
    renderCurrentAgentView(sessionId);
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
    state.historyWindowTargetCount = resolveViewportDrivenHistoryWindowCount(
      state.historyViewport,
      LENS_HISTORY_RETENTION_MIN_MARGIN,
      LENS_HISTORY_RETENTION_MAX_MARGIN,
      Math.max(LENS_HISTORY_WINDOW_SIZE, state.historyWindowCount),
      state.historyObservedHeights.values(),
    );
    const windowRevision = issueHistoryWindowRevision(sessionId, state);
    const nextSnapshot = await requestLensHistoryWindow(
      sessionId,
      state,
      undefined,
      state.historyWindowTargetCount,
      windowRevision,
    );
    traceLensHistoryFetch(sessionId, nextSnapshot, 'latest');
    if (applyFetchedLensHistoryWindow(sessionId, state, nextSnapshot)) {
      renderCurrentAgentView(sessionId);
    }
  } catch (error) {
    log.warn(() => `Failed to load latest Lens history for ${sessionId}: ${String(error)}`);
  } finally {
    state.refreshInFlight = false;
  }
}

async function syncHistoryWindowToViewport(
  sessionId: string,
  state: SessionLensViewState,
): Promise<void> {
  if (state.refreshInFlight || !state.snapshot) {
    return;
  }

  const hasAnchor = historyRender.captureHistoryViewportAnchor(state);
  const anchorAbsoluteIndex = hasAnchor
    ? (state.pendingHistoryPrependAnchor?.absoluteIndex ?? null)
    : null;
  const requestedWindow = historyRender.getViewportCenteredHistoryWindowRequest(state, {
    minimumMarginItems: LENS_HISTORY_RETENTION_MIN_MARGIN,
    maximumMarginItems: LENS_HISTORY_RETENTION_MAX_MARGIN,
    anchorAbsoluteIndex,
  });
  if (!requestedWindow) {
    state.pendingHistoryPrependAnchor = null;
    return;
  }

  const isBackwardShift = requestedWindow.startIndex < state.historyWindowStart;
  if (isBackwardShift && hasAnchor && !state.historyAutoScrollPinned) {
    setHistoryScrollMode(state, 'restore-anchor');
  }
  state.refreshInFlight = true;
  try {
    const windowRevision = issueHistoryWindowRevision(sessionId, state);
    const nextSnapshot = await requestLensHistoryWindow(
      sessionId,
      state,
      requestedWindow.startIndex,
      requestedWindow.count,
      windowRevision,
    );
    traceLensHistoryFetch(sessionId, nextSnapshot, 'scroll');
    if (applyFetchedLensHistoryWindow(sessionId, state, nextSnapshot)) {
      renderCurrentAgentView(sessionId);
    }
  } catch (error) {
    log.warn(
      () =>
        `Failed to sync viewport-centered Lens history for ${sessionId} (${isBackwardShift ? 'backward' : 'forward'}): ${String(error)}`,
    );
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

  renderAgentView(state.panel, state.snapshot, state.streamConnected, state);
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
  snapshot: LensHistorySnapshot,
  streamConnected: boolean,
  state: SessionLensViewState,
): void {
  syncLensQuickSettingsFromSnapshot(snapshot.sessionId, snapshot.provider, snapshot.quickSettings);
  syncAgentViewPresentation(panel, snapshot.provider);
  panel.dataset.agentTurnId = snapshot.currentTurn.turnId || '';
  syncLensTurnExecutionState(snapshot.sessionId, snapshot.currentTurn);
  historyRender.syncRequestInteractionState(state, snapshot.requests);
  const historyEntries = preservePersistentCommandEntries(
    buildLensHistoryEntries(snapshot),
    state.historyEntries,
    snapshot,
  );
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
  preservePersistentCommandEntries,
  shouldHideStatusInMeta,
  withActivationIssueNotice,
  withLiveAssistantState,
  withTrailingBusyIndicator,
} from './historyProcessing';
export {
  computeHistoryVirtualWindow,
  hasActiveLensSelectionInPanel,
  isScrollContainerNearBottom,
  resolveHistoryScrollMode,
} from './historyViewport';
export { suppressActiveComposerRequestEntries } from './historyRender';
export { applyCanonicalLensDelta } from './snapshotState';

async function waitForInitialLensSnapshot(
  sessionId: string,
  state: SessionLensViewState,
  activationRunId: number,
): Promise<LensHistorySnapshot> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    ensureLensActivationIsCurrent(state, activationRunId);
    try {
      const desiredWindowCount = resolveViewportDrivenHistoryWindowCount(
        state.historyViewport,
        LENS_HISTORY_RETENTION_MIN_MARGIN,
        LENS_HISTORY_RETENTION_MAX_MARGIN,
        state.historyWindowCount,
        state.historyObservedHeights.values(),
      );
      state.historyWindowTargetCount = desiredWindowCount;
      const windowRevision = issueHistoryWindowRevision(sessionId, state);
      const snapshot = state.snapshot
        ? await requestLensHistoryWindow(
            sessionId,
            state,
            state.historyWindowStart,
            state.historyWindowCount,
            windowRevision,
          )
        : await requestLensHistoryWindow(
            sessionId,
            state,
            undefined,
            desiredWindowCount,
            windowRevision,
          );
      traceLensHistoryFetch(sessionId, snapshot, 'initial');
      applyLensHistoryWindowState(state, snapshot);
      ensureLensActivationIsCurrent(state, activationRunId);
      if (attempt > 1) {
        appendActivationTrace(
          state,
          'positive',
          `history window retry ${attempt}`,
          lensText(
            'lens.activation.snapshotReady.summary',
            'Lens history window became available.',
          ),
          lensFormat(
            'lens.activation.snapshotReady.body',
            'MidTerm produced the first canonical Lens history window on retry {attempt}.',
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
        `history window retry ${attempt}`,
        lensText('lens.activation.snapshotPending', 'Lens history window not ready yet.'),
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
    if (state.snapshot) {
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

/* eslint-enable max-lines */
