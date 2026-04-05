import { createLogger } from '../logging';
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
import { renderMarkdownFragment } from '../../utils/markdown';
import type { LensAttachmentReference, LensPulseRuntimeNotice } from '../../api/types';
import {
  attachSessionLens,
  detachSessionLens,
  getLensSnapshot,
  approveLensRequest,
  declineLensRequest,
  resolveLensUserInput,
  openLensEventStream,
  type LensPulseDeltaResponse,
  type LensPulseEvent,
  type LensPulseRequestSummary,
  type LensPulseSnapshotResponse,
  type LensPulseHistoryEntry,
  LensHttpError,
} from '../../api/client';
import { t } from '../i18n';
import { buildTerminalFontStack, getConfiguredTerminalFontFamily } from '../terminal/fontConfig';
import { $activeSessionId, getSession } from '../../stores';

const log = createLogger('agentView');
const viewStates = new Map<string, SessionLensViewState>();
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;
const HISTORY_OVERSCAN_PX = 800;
const HISTORY_VIRTUALIZE_AFTER = 50;
const LENS_HISTORY_WINDOW_SIZE = 80;
const LENS_HISTORY_PAGE_SIZE = 40;
const LENS_HISTORY_FETCH_THRESHOLD_PX = 240;
const COLLAPSIBLE_HISTORY_BODY_MIN_LINES = 8;
const COLLAPSIBLE_HISTORY_BODY_MIN_CHARS = 320;
const COLLAPSIBLE_HISTORY_BODY_PREVIEW_CHARS = 160;
const MAX_VISIBLE_DIFF_LINES = 200;
const USER_HISTORY_SCROLL_INTENT_WINDOW_MS = 900;
const STALE_LENS_ACTIVATION = '__midterm_stale_lens_activation__';
let lensTurnLifecycleBound = false;
let lensActiveSessionBound = false;
let lensSelectionGuardBound = false;

interface SessionLensViewState {
  panel: HTMLDivElement;
  snapshot: LensPulseSnapshotResponse | null;
  events: LensPulseEvent[];
  debugScenarioActive: boolean;
  activationRunId: number;
  historyViewport: HTMLDivElement | null;
  historyEntries: LensHistoryEntry[];
  historyWindowStart: number;
  historyWindowCount: number;
  disconnectStream: (() => void) | null;
  streamConnected: boolean;
  refreshInFlight: boolean;
  requestBusyIds: Set<string>;
  requestDraftAnswersById: Record<string, Record<string, string[]>>;
  requestQuestionIndexById: Record<string, number>;
  historyAutoScrollPinned: boolean;
  historyLastScrollMetrics: HistoryScrollMetrics | null;
  historyLastUserScrollIntentAt: number;
  historyRenderScheduled: number | null;
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
  activationIssue: LensActivationIssue | null;
  activationActionBusy: boolean;
  optimisticTurns: PendingLensTurn[];
  renderDirty: boolean;
  assistantMarkdownCache: Map<string, AssistantMarkdownCacheEntry>;
  historyRenderedNodes: Map<string, HistoryRenderedNode>;
  historyTopSpacer: HTMLDivElement | null;
  historyBottomSpacer: HTMLDivElement | null;
  historyEmptyState: HTMLDivElement | null;
  pendingHistoryPrependOffsetPx: number;
  historyExpandedEntries: Set<string>;
  runtimeStats: LensRuntimeStatsSummary | null;
  busyIndicatorTickHandle: number | null;
  completedTurnDurationEntries: Map<string, LensHistoryEntry>;
}

export interface LensRuntimeStatsSummary {
  windowUsedTokens: number | null;
  windowTokenLimit: number | null;
  accumulatedInputTokens: number;
  accumulatedOutputTokens: number;
  primaryRateLimitUsedPercent: number | null;
  secondaryRateLimitUsedPercent: number | null;
}

interface PendingLensTurn {
  optimisticId: string;
  turnId: string | null;
  text: string;
  attachments: LensAttachmentReference[];
  submittedAt: string;
  status: 'submitted' | 'accepted';
}

interface LensActivationTraceEntry {
  tone: HistoryTone;
  meta: string;
  summary: string;
  detail: string;
}

interface AssistantMarkdownCacheEntry {
  body: string;
  html: string;
}

type HistoryKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool'
  | 'request'
  | 'plan'
  | 'diff'
  | 'system'
  | 'notice';
type HistoryTone = 'info' | 'positive' | 'warning' | 'attention';
type LensHistoryActionId = 'retry-lens';
export type LensDebugScenarioName = 'mixed' | 'tables' | 'long' | 'workflow';
export type LensLayoutMode = 'default' | 'full-width-left';

const LENS_DEBUG_SCENARIO_NAMES: readonly LensDebugScenarioName[] = [
  'mixed',
  'tables',
  'long',
  'workflow',
];

interface LensHistoryAction {
  id: LensHistoryActionId;
  label: string;
  style: 'primary' | 'secondary';
  busyLabel?: string;
}

export interface LensActivationIssue {
  kind:
    | 'busy-terminal-turn'
    | 'missing-resume-id'
    | 'shell-recovery-failed'
    | 'native-runtime-unavailable'
    | 'readonly-history'
    | 'startup-failed';
  tone: HistoryTone;
  meta: string;
  title: string;
  body: string;
  actions: LensHistoryAction[];
}

export interface LensHistoryEntry {
  id: string;
  order: number;
  kind: HistoryKind;
  tone: HistoryTone;
  label: string;
  title: string;
  body: string;
  meta: string;
  requestId?: string;
  attachments?: LensAttachmentReference[];
  actions?: LensHistoryAction[];
  live?: boolean;
  pending?: boolean;
  sourceItemId?: string | null;
  sourceTurnId?: string | null;
  sourceItemType?: string | null;
  busyIndicator?: boolean;
  busyElapsedText?: string | null;
  turnDurationNote?: boolean;
  commandText?: string | null;
  commandOutputTail?: string[];
}

export interface HistoryVirtualWindow {
  start: number;
  end: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
}

interface HistoryViewportMetrics {
  scrollTop: number;
  clientHeight: number;
  clientWidth: number;
}

interface HistoryScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

interface HistoryVisibleEntry {
  key: string;
  entry: LensHistoryEntry;
  cluster: ArtifactClusterInfo | null;
  signature: string;
}

interface HistoryRenderPlan {
  emptyStateText: string | null;
  topSpacerPx: number;
  bottomSpacerPx: number;
  visibleEntries: HistoryVisibleEntry[];
}

interface HistoryRenderedNode {
  node: HTMLElement;
  signature: string;
  entry: LensHistoryEntry;
  cluster: ArtifactClusterInfo | null;
}

export interface HistoryBodyPresentation {
  mode: 'plain' | 'monospace' | 'markdown' | 'streaming' | 'diff' | 'command';
  collapsedByDefault: boolean;
  lineCount: number;
  preview: string;
}

interface CommandToken {
  text: string;
  kind: 'command' | 'parameter' | 'string' | 'operator' | 'text' | 'whitespace';
}

export interface DiffRenderLine {
  text: string;
  className: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

interface ArtifactClusterInfo {
  position: 'single' | 'start' | 'middle' | 'end';
  label: string | null;
  count: number;
  onlyTools: boolean;
}

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
    ensureAgentViewSkeleton(sessionId, panel);
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

  ensureAgentViewSkeleton(sessionId, panel);
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
    buildCanonicalSnapshotHistoryEntries(snapshot).length > 0 ||
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

function normalizeLensDebugScenarioName(scenario: string): LensDebugScenarioName {
  return LENS_DEBUG_SCENARIO_NAMES.includes(scenario as LensDebugScenarioName)
    ? (scenario as LensDebugScenarioName)
    : 'mixed';
}

function buildLensDebugScenario(
  sessionId: string,
  scenario: LensDebugScenarioName,
  origin: string,
): {
  snapshot: LensPulseSnapshotResponse;
  events: LensPulseEvent[];
} {
  const now = Date.now();
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const heroImageUrl = new URL('/img/logo.png', origin).href;

  const createItem = (
    itemId: string,
    itemType: string,
    detail: string,
    updatedAt: string,
  ): LensPulseSnapshotResponse['items'][number] => ({
    itemId,
    turnId: 'turn-debug',
    itemType,
    status: 'completed',
    title: itemType === 'user_message' ? 'User message' : 'Assistant message',
    detail,
    attachments: [],
    updatedAt,
  });

  let items!: LensPulseSnapshotResponse['items'];
  let requests: LensPulseSnapshotResponse['requests'] = [];
  let assistantText!: string;
  let currentTurnState: LensPulseSnapshotResponse['currentTurn']['state'] = 'completed';
  let currentTurnStateLabel = 'Completed';

  if (scenario === 'tables') {
    items = [
      createItem(
        'user-debug-table',
        'user_message',
        'Stress the Lens history with wide markdown tables and dense comparisons.',
        at(-180000),
      ),
    ];
    assistantText = [
      'Here is a dense status sheet for the current worker fleet.',
      '',
      '| Lane | Mode | State | Last token burst | Scrollback | CPU peak | First paint | Attach P95 | Model | Owner | Queue | Notes |',
      '| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | :--- | :--- | ---: | :--- |',
      '| Alpha | Lens | Streaming | 1420 | 18233 | 68% | 118 ms | 880 ms | gpt-5.4 | Codex | 0 | Long answer with code and tables kept live while the operator watches scrollback |',
      '| Beta | Terminal | Idle | 0 | 932 | 12% | 74 ms | 140 ms | none | Human | 1 | Waiting for next prompt and preserving shell ownership |',
      '| Gamma | Lens | Blocked | 17 | 4112 | 31% | 129 ms | 1420 ms | gpt-5.4-mini | Codex | 3 | Approval request open and should stay visible even when the assistant lane is busy |',
      '| Delta | Lens | Replaying | 921 | 15540 | 54% | 105 ms | 650 ms | claude-opus | Claude | 0 | Canonical history restored from MidTerm and replayed into the history lane |',
      '',
      '| Metric | P50 | P95 | P99 | Target | Last good build | Regressed by | Notes |',
      '| --- | ---: | ---: | ---: | ---: | :--- | :--- | :--- |',
      '| First paint | 118 ms | 212 ms | 356 ms | 150 ms | v8.7.41-dev | +9 ms | Still acceptable in the local source loop |',
      '| Lens attach | 420 ms | 880 ms | 1420 ms | 600 ms | v8.7.39-dev | +140 ms | Regression only visible on native-runtime-blocked sessions |',
      '| Snapshot rebuild | 34 ms | 68 ms | 110 ms | 50 ms | v8.7.50-dev | -6 ms | Fast enough once canonical history exists |',
      '',
      '| Render mode | Benefit | Risk |',
      '| :--- | :--- | :--- |',
      '| Virtual window | Keeps long histories fast | Needs stable bottom pinning |',
      '| Inline tables | Preserves structure for operators | Can overflow on mobile without scroll container |',
    ].join('\n');
  } else if (scenario === 'long') {
    items = Array.from({ length: 140 }, (_value, index) => {
      const isUser = index % 2 === 0;
      const ordinal = index + 1;
      const body = isUser
        ? `Prompt ${ordinal}: summarize lane ${Math.floor(index / 2) + 1} and keep the history compact.`
        : [
            `Reply ${ordinal}: lane ${Math.floor(index / 2) + 1} is stable.`,
            '',
            ordinal % 10 === 1
              ? '| Check | Value |\n| :--- | ---: |\n| backlog | 7 |\n| diff hunks | 3 |'
              : 'Streaming stays smooth when cards remain narrow, labels stay quiet, and long histories virtualize cleanly.',
          ].join('\n');

      return createItem(
        `${isUser ? 'user' : 'assistant'}-debug-${ordinal}`,
        isUser ? 'user_message' : 'assistant_message',
        body,
        at(-240000 + index * 1200),
      );
    });
    assistantText = '';
  } else if (scenario === 'workflow') {
    items = [
      createItem(
        'user-debug-workflow',
        'user_message',
        'Audit the workspace, ask for the release mode, then patch the report and summarize the diff.',
        at(-150000),
      ),
    ];
    requests = [
      {
        requestId: 'request-debug-workflow',
        turnId: 'turn-debug',
        kind: 'tool_user_input',
        kindLabel: 'Question',
        state: 'open',
        decision: null,
        detail: 'The agent is blocked until the operator chooses the release posture.',
        questions: [
          {
            id: 'mode',
            question: 'Choose SAFE or FAST before I continue.',
            header: 'Release mode',
            multiSelect: false,
            options: [
              {
                label: 'SAFE',
                description: 'Validate carefully and preserve the current shape.',
              },
              {
                label: 'FAST',
                description: 'Move quickly and accept a rougher pass.',
              },
            ],
          },
        ],
        answers: [],
        updatedAt: at(-12000),
      },
    ];
    assistantText = [
      'Plan:',
      '1. Inspect the workspace state.',
      '2. Wait for the release mode.',
      '3. Apply the requested patch and summarize the diff.',
      '',
      '| file | status | owner |',
      '| :--- | :--- | :--- |',
      '| report.md | pending | Codex |',
      '| inventory.csv | reviewed | Operator |',
    ].join('\n');
    currentTurnState = 'running';
    currentTurnStateLabel = 'Running';
  } else {
    items = [
      createItem(
        'user-debug-mixed',
        'user_message',
        'Give me a power-user quality pass: smooth streaming, compact labels, readable tables, and inline media.',
        at(-120000),
      ),
    ];
    requests = [
      {
        requestId: 'request-debug-choice',
        turnId: 'turn-debug',
        kind: 'tool_user_input',
        kindLabel: 'User input',
        state: 'open',
        decision: null,
        detail: 'Pick the shipping posture for this polish pass.',
        questions: [
          {
            id: 'posture',
            question: 'Which rollout posture fits this history best?',
            header: 'Posture',
            multiSelect: false,
            options: [
              {
                label: 'Local proof',
                description: 'Validate in the source loop first.',
              },
              {
                label: 'Pre-release',
                description: 'Cut a dev build after browser proof.',
              },
            ],
          },
        ],
        answers: [],
        updatedAt: at(-15000),
      },
    ];
    assistantText = [
      'The current Lens pass is tuned for operators instead of messenger chrome.',
      '',
      '![Inline Lens media preview](' + heroImageUrl + ')',
      '',
      '| Surface | Goal | Status |',
      '| :--- | :--- | :---: |',
      '| History chrome | Stay quiet and readable | Good |',
      '| Streaming feel | Keep the answer alive while it grows | Live |',
      '| Tables | Preserve structure without blowing out the lane | Better |',
      '',
      '```ts',
      'const historyMode = "power-user";',
      'const keepLabelsQuiet = true;',
      '```',
      '',
      'Next I would pressure-test this with many long turns, wide tables, and mixed media so the renderer fails in development instead of production.',
    ].join('\n');
    currentTurnState = 'running';
    currentTurnStateLabel = 'Running';
  }

  return {
    snapshot: {
      sessionId,
      provider: 'codex',
      generatedAt: at(0),
      latestSequence: 500,
      totalHistoryCount: items.length,
      historyWindowStart: 0,
      historyWindowEnd: items.length,
      hasOlderHistory: false,
      hasNewerHistory: false,
      session: {
        state: currentTurnState === 'running' ? 'running' : 'ready',
        stateLabel: currentTurnState === 'running' ? 'Running' : 'Ready',
        reason:
          scenario === 'long'
            ? 'Long synthetic history loaded for history virtualization.'
            : 'Lens debug scenario loaded from the browser console.',
        lastError: null,
        lastEventAt: at(0),
      },
      thread: {
        threadId: `thread-debug-${scenario}`,
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-debug',
        state: currentTurnState,
        stateLabel: currentTurnStateLabel,
        model: 'gpt-5.4',
        effort: 'high',
        startedAt: at(-90000),
        completedAt: currentTurnState === 'running' ? null : at(-5000),
      },
      quickSettings: {
        model: 'gpt-5.4',
        effort: 'high',
        planMode: scenario === 'workflow' ? 'on' : 'off',
        permissionMode: 'manual',
      },
      streams: {
        assistantText,
        reasoningText:
          scenario === 'workflow'
            ? 'Need the operator choice before touching the file so the patch posture is explicit.'
            : '',
        reasoningSummaryText:
          scenario === 'workflow'
            ? 'Waiting on SAFE/FAST, then update report.md and show the working diff.'
            : '',
        planText:
          scenario === 'workflow'
            ? '1. Read the workspace.\n2. Ask for SAFE or FAST.\n3. Patch and summarize the diff.'
            : '',
        commandOutput: scenario === 'workflow' ? 'status: TODO\nowner: codex' : '',
        fileChangeOutput:
          scenario === 'workflow' ? 'Success. Updated the following files:\nM report.md' : '',
        unifiedDiff:
          scenario === 'workflow'
            ? 'diff --git a/report.md b/report.md\n@@\n-status: TODO\n+status: DONE'
            : '',
      },
      // The backend snapshot contract still uses the legacy `transcript` field
      // name. Lens semantics in the frontend treat this as canonical history.
      transcript: buildDebugScenarioHistory({
        generatedAt: at(0),
        turnId: 'turn-debug',
        currentTurnState,
        currentTurnStateLabel,
        items,
        requests,
        assistantText,
        reasoningText:
          scenario === 'workflow'
            ? 'Need the operator choice before touching the file so the patch posture is explicit.'
            : '',
        reasoningSummaryText:
          scenario === 'workflow'
            ? 'Waiting on SAFE/FAST, then update report.md and show the working diff.'
            : '',
        planText:
          scenario === 'workflow'
            ? '1. Read the workspace.\n2. Ask for SAFE or FAST.\n3. Patch and summarize the diff.'
            : '',
        commandOutput: scenario === 'workflow' ? 'status: TODO\nowner: codex' : '',
        fileChangeOutput:
          scenario === 'workflow' ? 'Success. Updated the following files:\nM report.md' : '',
        unifiedDiff:
          scenario === 'workflow'
            ? 'diff --git a/report.md b/report.md\n@@\n-status: TODO\n+status: DONE'
            : '',
      }),
      items,
      requests,
      notices: [],
    },
    events: [],
  };
}

function buildDebugScenarioHistory(args: {
  generatedAt: string;
  turnId: string;
  currentTurnState: string;
  currentTurnStateLabel: string;
  items: LensPulseSnapshotResponse['items'];
  requests: LensPulseSnapshotResponse['requests'];
  assistantText: string;
  reasoningText: string;
  reasoningSummaryText: string;
  planText: string;
  commandOutput: string;
  fileChangeOutput: string;
  unifiedDiff: string;
}): LensPulseHistoryEntry[] {
  const historyEntries: LensPulseHistoryEntry[] = [];
  let order = 1;

  for (const item of args.items) {
    historyEntries.push({
      entryId: `${historyKindFromItem(item.itemType)}:${item.turnId || item.itemId}`,
      order: order++,
      kind: historyKindFromItem(item.itemType),
      turnId: item.turnId ?? null,
      itemId: item.itemId,
      requestId: null,
      status: item.status,
      itemType: item.itemType,
      title: item.title ?? null,
      body: item.detail || '',
      attachments: cloneHistoryAttachments(item.attachments),
      streaming: false,
      createdAt: item.updatedAt,
      updatedAt: item.updatedAt,
    });
  }

  const pushStream = (kind: string, title: string | null, body: string): void => {
    if (!body.trim()) {
      return;
    }

    const status =
      kind === 'assistant' && args.currentTurnState === 'running' ? 'streaming' : 'completed';

    historyEntries.push({
      entryId: `${kind}:${args.turnId}:${order}`,
      order: order++,
      kind,
      turnId: args.turnId,
      itemId: null,
      requestId: null,
      status,
      itemType: kind,
      title,
      body,
      attachments: [],
      streaming: kind === 'assistant' && args.currentTurnState === 'running',
      createdAt: args.generatedAt,
      updatedAt: args.generatedAt,
    });
  };

  pushStream('assistant', null, args.assistantText);
  pushStream('reasoning', 'Reasoning', args.reasoningText);
  pushStream('reasoning', 'Reasoning summary', args.reasoningSummaryText);
  pushStream('plan', 'Plan', args.planText);
  pushStream('tool', 'Command output', args.commandOutput);
  pushStream('tool', 'File change output', args.fileChangeOutput);
  pushStream('diff', 'Working diff', args.unifiedDiff);

  for (const request of args.requests) {
    historyEntries.push({
      entryId: `request:${request.requestId}`,
      order: order++,
      kind: 'request',
      turnId: request.turnId ?? null,
      itemId: null,
      requestId: request.requestId,
      status: request.state,
      itemType: request.kind,
      title: request.kindLabel,
      body: [request.detail, ...request.questions.map((question) => question.question)]
        .filter(Boolean)
        .join('\n\n'),
      attachments: [],
      streaming: false,
      createdAt: request.updatedAt,
      updatedAt: request.updatedAt,
    });
  }

  return historyEntries;
}

function ensureAgentViewSkeleton(sessionId: string, panel: HTMLDivElement): void {
  syncAgentViewPresentation(panel);
  if (panel.dataset.agentViewReady === 'true') {
    return;
  }

  panel.dataset.agentViewReady = 'true';
  panel.classList.add('agent-view-panel');
  panel.innerHTML = `
    <section class="agent-view">
      <div class="agent-chat-shell">
        <div class="agent-runtime-stats" data-agent-field="runtime-stats" hidden></div>
        <div class="agent-history" data-agent-field="history"></div>
        <button type="button" class="agent-scroll-to-bottom" data-agent-field="scroll-to-bottom" hidden>${lensText('lens.scrollToBottom', 'Back to bottom')}</button>
        <section class="agent-composer-shell">
          <div class="agent-composer-interruption" data-agent-field="composer-interruption" hidden></div>
          <div class="agent-composer-host" data-agent-field="composer-host"></div>
        </section>
      </div>
    </section>
  `;

  panel.addEventListener('keydown', (event) => {
    if (
      event.key !== 'Escape' ||
      event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    ) {
      return;
    }

    event.preventDefault();
    void handleLensEscape(sessionId);
  });
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

    const scrollMetrics = readHistoryScrollMetrics(currentViewport);
    current.historyAutoScrollPinned = resolveHistoryAutoScrollPinned({
      wasPinned: current.historyAutoScrollPinned,
      previous: current.historyLastScrollMetrics,
      current: scrollMetrics,
      userInitiated:
        Date.now() - current.historyLastUserScrollIntentAt <= USER_HISTORY_SCROLL_INTENT_WINDOW_MS,
    });
    current.historyLastScrollMetrics = scrollMetrics;
    renderScrollToBottomControl(current.panel, current);

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
      scrollHistoryToBottom(sessionId, 'smooth');
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
    state.pendingHistoryPrependOffsetPx = prependedEntries.reduce(
      (sum, entry) => sum + estimateHistoryEntryHeight(mapSnapshotEntryToHistoryEntry(entry)),
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

function applyLensSnapshotWindowState(
  state: SessionLensViewState,
  snapshot: LensPulseSnapshotResponse,
): void {
  const windowStart =
    typeof snapshot.historyWindowStart === 'number' ? snapshot.historyWindowStart : 0;
  const windowEnd =
    typeof snapshot.historyWindowEnd === 'number'
      ? snapshot.historyWindowEnd
      : windowStart + snapshot.transcript.length;
  const windowSize = Math.max(0, windowEnd - windowStart);
  state.historyWindowStart = windowStart;
  state.historyWindowCount = Math.max(windowSize, LENS_HISTORY_WINDOW_SIZE);
}

function collapseSnapshotToLatestWindow(
  state: SessionLensViewState,
  targetWindowCount: number,
): void {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }

  const retainedEntries =
    snapshot.transcript.length > targetWindowCount
      ? snapshot.transcript.slice(-targetWindowCount)
      : snapshot.transcript.slice();
  const totalHistoryCount = Math.max(snapshot.totalHistoryCount, retainedEntries.length);

  snapshot.transcript = retainedEntries;
  snapshot.totalHistoryCount = totalHistoryCount;
  snapshot.historyWindowEnd = totalHistoryCount;
  snapshot.historyWindowStart = Math.max(0, snapshot.historyWindowEnd - retainedEntries.length);
  snapshot.hasOlderHistory = snapshot.historyWindowStart > 0;
  snapshot.hasNewerHistory = false;
  state.historyWindowStart = snapshot.historyWindowStart;
  state.historyWindowCount = Math.max(targetWindowCount, retainedEntries.length);
}

export function applyCanonicalLensDelta(
  state: SessionLensViewState,
  delta: LensPulseDeltaResponse,
): void {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }

  const previousTotalHistoryCount = snapshot.totalHistoryCount;
  snapshot.provider = delta.provider || snapshot.provider;
  snapshot.generatedAt = delta.generatedAt;
  snapshot.latestSequence = Math.max(snapshot.latestSequence, delta.latestSequence);
  snapshot.totalHistoryCount = Math.max(delta.totalHistoryCount, snapshot.totalHistoryCount);
  snapshot.session = cloneSnapshotSessionSummary(delta.session);
  snapshot.thread = cloneSnapshotThreadSummary(delta.thread);
  snapshot.currentTurn = cloneSnapshotTurnSummary(delta.currentTurn);
  snapshot.quickSettings = cloneSnapshotQuickSettingsSummary(delta.quickSettings);
  snapshot.streams = cloneSnapshotStreamsSummary(delta.streams);
  snapshot.items = upsertSnapshotItems(snapshot.items, delta.itemUpserts, delta.itemRemovals);
  snapshot.requests = upsertSnapshotRequests(
    snapshot.requests,
    delta.requestUpserts,
    delta.requestRemovals,
  );
  snapshot.notices = upsertSnapshotNotices(snapshot.notices, delta.noticeUpserts);
  applyHistoryWindowDelta(
    state,
    snapshot,
    previousTotalHistoryCount,
    delta.historyUpserts,
    delta.historyRemovals,
  );
}

function applyHistoryWindowDelta(
  state: SessionLensViewState,
  snapshot: LensPulseSnapshotResponse,
  previousTotalHistoryCount: number,
  upserts: readonly LensPulseHistoryEntry[],
  removals: readonly string[],
): void {
  const currentWindowStart = snapshot.historyWindowStart;
  const currentWindowEnd = snapshot.historyWindowEnd;
  const wasLiveEdge = currentWindowEnd >= previousTotalHistoryCount;
  const nextEntries = snapshot.transcript.map(cloneSnapshotHistoryEntry);
  const entryIndexById = new Map(nextEntries.map((entry, index) => [entry.entryId, index]));

  for (const entryId of removals) {
    const index = entryIndexById.get(entryId);
    if (index === undefined) {
      continue;
    }

    nextEntries.splice(index, 1);
    entryIndexById.delete(entryId);
    reindexHistoryEntryMap(entryIndexById, nextEntries);
  }

  for (const upsert of upserts) {
    const cloned = cloneSnapshotHistoryEntry(upsert);
    const existingIndex = entryIndexById.get(cloned.entryId);
    if (existingIndex !== undefined) {
      nextEntries.splice(existingIndex, 1, cloned);
      continue;
    }

    if (wasLiveEdge) {
      nextEntries.push(cloned);
      entryIndexById.set(cloned.entryId, nextEntries.length - 1);
      continue;
    }

    const absoluteIndex = Math.max(0, cloned.order - 1);
    if (absoluteIndex >= currentWindowStart && absoluteIndex < currentWindowEnd) {
      nextEntries.push(cloned);
      entryIndexById.set(cloned.entryId, nextEntries.length - 1);
    }
  }

  nextEntries.sort((left, right) => left.order - right.order);
  const targetWindowCount = Math.max(1, state.historyWindowCount || LENS_HISTORY_WINDOW_SIZE);

  if (wasLiveEdge) {
    const trimmedEntries =
      nextEntries.length > targetWindowCount
        ? nextEntries.slice(-targetWindowCount)
        : nextEntries.slice();
    snapshot.transcript = trimmedEntries;
    snapshot.historyWindowEnd = snapshot.totalHistoryCount;
    snapshot.historyWindowStart = Math.max(0, snapshot.historyWindowEnd - trimmedEntries.length);
  } else {
    snapshot.transcript = nextEntries.filter((entry) => {
      const absoluteIndex = Math.max(0, entry.order - 1);
      return absoluteIndex >= currentWindowStart && absoluteIndex < currentWindowEnd;
    });
    snapshot.historyWindowStart = currentWindowStart;
    snapshot.historyWindowEnd = snapshot.historyWindowStart + snapshot.transcript.length;
  }

  snapshot.hasOlderHistory = snapshot.historyWindowStart > 0;
  snapshot.hasNewerHistory = snapshot.historyWindowEnd < snapshot.totalHistoryCount;
  state.historyWindowStart = snapshot.historyWindowStart;
  state.historyWindowCount = Math.max(snapshot.transcript.length, targetWindowCount);
}

function reindexHistoryEntryMap(
  entryIndexById: Map<string, number>,
  entries: readonly LensPulseHistoryEntry[],
): void {
  entryIndexById.clear();
  entries.forEach((entry, index) => {
    entryIndexById.set(entry.entryId, index);
  });
}

function upsertSnapshotItems(
  current: readonly LensPulseSnapshotResponse['items'][number][],
  upserts: readonly LensPulseSnapshotResponse['items'][number][],
  removals: readonly string[],
): LensPulseSnapshotResponse['items'] {
  const next = new Map(current.map((item) => [item.itemId, cloneSnapshotItemSummary(item)]));

  for (const itemId of removals) {
    next.delete(itemId);
  }

  for (const item of upserts) {
    next.set(item.itemId, cloneSnapshotItemSummary(item));
  }

  return Array.from(next.values()).sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );
}

function upsertSnapshotRequests(
  current: readonly LensPulseSnapshotResponse['requests'][number][],
  upserts: readonly LensPulseSnapshotResponse['requests'][number][],
  removals: readonly string[],
): LensPulseSnapshotResponse['requests'] {
  const next = new Map(
    current.map((request) => [request.requestId, cloneSnapshotRequestSummary(request)]),
  );

  for (const requestId of removals) {
    next.delete(requestId);
  }

  for (const request of upserts) {
    next.set(request.requestId, cloneSnapshotRequestSummary(request));
  }

  return Array.from(next.values()).sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );
}

function upsertSnapshotNotices(
  current: readonly LensPulseSnapshotResponse['notices'][number][],
  upserts: readonly LensPulseSnapshotResponse['notices'][number][],
): LensPulseSnapshotResponse['notices'] {
  const next = new Map(
    current.map((notice) => [notice.eventId, cloneSnapshotRuntimeNotice(notice)]),
  );

  for (const notice of upserts) {
    next.set(notice.eventId, cloneSnapshotRuntimeNotice(notice));
  }

  return Array.from(next.values()).sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

function cloneSnapshotHistoryEntry(entry: LensPulseHistoryEntry): LensPulseHistoryEntry {
  return {
    ...entry,
    attachments: cloneHistoryAttachments(entry.attachments),
  };
}

function cloneSnapshotItemSummary(
  item: LensPulseSnapshotResponse['items'][number],
): LensPulseSnapshotResponse['items'][number] {
  return {
    ...item,
    turnId: item.turnId ?? null,
    title: item.title ?? null,
    detail: item.detail ?? null,
    attachments: cloneHistoryAttachments(item.attachments),
  };
}

function cloneSnapshotRequestSummary(
  request: LensPulseSnapshotResponse['requests'][number],
): LensPulseSnapshotResponse['requests'][number] {
  return {
    ...request,
    turnId: request.turnId ?? null,
    detail: request.detail ?? null,
    decision: request.decision ?? null,
    questions: request.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
    answers: request.answers.map((answer) => ({
      questionId: answer.questionId,
      answers: [...answer.answers],
    })),
  };
}

function cloneSnapshotRuntimeNotice(
  notice: LensPulseSnapshotResponse['notices'][number],
): LensPulseSnapshotResponse['notices'][number] {
  return {
    ...notice,
    detail: notice.detail ?? null,
  };
}

function cloneSnapshotSessionSummary(
  session: LensPulseSnapshotResponse['session'],
): LensPulseSnapshotResponse['session'] {
  return {
    ...session,
    reason: session.reason ?? null,
    lastError: session.lastError ?? null,
    lastEventAt: session.lastEventAt ?? null,
  };
}

function cloneSnapshotThreadSummary(
  thread: LensPulseSnapshotResponse['thread'],
): LensPulseSnapshotResponse['thread'] {
  return {
    ...thread,
  };
}

function cloneSnapshotTurnSummary(
  turn: LensPulseSnapshotResponse['currentTurn'],
): LensPulseSnapshotResponse['currentTurn'] {
  return {
    ...turn,
    turnId: turn.turnId ?? null,
    model: turn.model ?? null,
    effort: turn.effort ?? null,
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
  };
}

function cloneSnapshotQuickSettingsSummary(
  quickSettings: LensPulseSnapshotResponse['quickSettings'] | null | undefined,
): LensPulseSnapshotResponse['quickSettings'] {
  return {
    model: quickSettings?.model ?? null,
    effort: quickSettings?.effort ?? null,
    planMode: quickSettings?.planMode ?? 'off',
    permissionMode: quickSettings?.permissionMode ?? 'manual',
  };
}

function cloneSnapshotStreamsSummary(
  streams: LensPulseSnapshotResponse['streams'],
): LensPulseSnapshotResponse['streams'] {
  return {
    ...streams,
  };
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
    renderActivationView(sessionId, state.panel, state);
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
  syncRequestInteractionState(state, snapshot.requests);
  const historyEntries = buildLensHistoryEntries(snapshot, events);
  const runtimeStats = buildLensRuntimeStats(snapshot);
  state.runtimeStats = runtimeStats;
  const visibleHistoryEntries = suppressActiveComposerRequestEntries(
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
  syncBusyIndicatorTicker(snapshot, state, renderedEntries);
  renderRuntimeStats(panel, runtimeStats);
  renderHistory(panel, renderedEntries, snapshot.sessionId);
  renderComposerInterruption(panel, snapshot.sessionId, snapshot.requests, state);
}

export function suppressActiveComposerRequestEntries(
  entries: readonly LensHistoryEntry[],
  requests: readonly LensPulseRequestSummary[],
): LensHistoryEntry[] {
  const activeRequest = findActiveComposerRequest(requests);
  if (!activeRequest || activeRequest.state !== 'open') {
    return [...entries];
  }

  return entries.filter(
    (entry) => entry.kind !== 'request' || entry.requestId !== activeRequest.requestId,
  );
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

function renderActivationView(
  sessionId: string,
  panel: HTMLDivElement,
  state: SessionLensViewState,
): void {
  syncAgentViewPresentation(panel, state.snapshot?.provider ?? null);
  panel.dataset.agentTurnId = '';
  renderRuntimeStats(panel, state.runtimeStats);
  renderComposerInterruption(panel, sessionId, [], state);
  renderHistory(
    panel,
    withActivationIssueNotice(buildActivationHistoryEntries(state), state.activationIssue),
    sessionId,
  );
}

function renderRuntimeStats(panel: HTMLDivElement, stats: LensRuntimeStatsSummary | null): void {
  const host = panel.querySelector<HTMLDivElement>('[data-agent-field="runtime-stats"]');
  if (!host) {
    return;
  }

  if (!stats) {
    host.hidden = true;
    host.replaceChildren();
    if (typeof host.removeAttribute === 'function') {
      host.removeAttribute('aria-label');
      host.removeAttribute('title');
    } else if (typeof host.setAttribute === 'function') {
      host.setAttribute('aria-label', '');
      host.setAttribute('title', '');
    }
    return;
  }

  const compact = [
    formatTokenWindowCompact(stats),
    `in ${formatTokenCount(stats.accumulatedInputTokens)}`,
    `out ${formatTokenCount(stats.accumulatedOutputTokens)}`,
  ].join('  ');
  const detailParts = [
    formatTokenWindowDetail(stats),
    `Session in ${formatTokenCount(stats.accumulatedInputTokens)}`,
    `Session out ${formatTokenCount(stats.accumulatedOutputTokens)}`,
  ];
  if (stats.primaryRateLimitUsedPercent !== null || stats.secondaryRateLimitUsedPercent !== null) {
    detailParts.push(
      `Rate ${formatPercent(stats.primaryRateLimitUsedPercent)} / ${formatPercent(stats.secondaryRateLimitUsedPercent)}`,
    );
  }

  host.hidden = false;
  host.setAttribute('aria-label', detailParts.join(' | '));
  host.title = detailParts.join('\n');
  host.replaceChildren();

  const compactText = document.createElement('span');
  compactText.className = 'agent-runtime-stats-compact';
  compactText.textContent = compact;
  host.appendChild(compactText);

  const detail = document.createElement('div');
  detail.className = 'agent-runtime-stats-detail';
  for (const part of detailParts) {
    const line = document.createElement('div');
    line.className = 'agent-runtime-stats-detail-line';
    line.textContent = part;
    detail.appendChild(line);
  }

  host.appendChild(detail);
}

function renderHistory(
  panel: HTMLDivElement,
  entries: LensHistoryEntry[],
  sessionId: string,
): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="history"]');
  if (!container) {
    return;
  }

  const state = viewStates.get(sessionId);
  if (state) {
    state.historyViewport = container as HTMLDivElement;
    state.historyEntries = entries;
    state.historyLastScrollMetrics ??= readHistoryScrollMetrics(container as HTMLDivElement);
    pruneAssistantMarkdownCache(state, entries);
    renderScrollToBottomControl(panel, state);
  }

  const viewport = container as HTMLDivElement;
  const metrics = readHistoryViewportMetrics(viewport);
  const renderPlan = buildHistoryRenderPlan(entries, metrics, state);
  reconcileHistoryRenderPlan(sessionId, viewport, renderPlan);

  if (state && state.pendingHistoryPrependOffsetPx > 0 && !state.historyAutoScrollPinned) {
    const restoreOffset = state.pendingHistoryPrependOffsetPx;
    state.pendingHistoryPrependOffsetPx = 0;
    window.requestAnimationFrame(() => {
      viewport.scrollTop += restoreOffset;
    });
  }

  if (state?.historyAutoScrollPinned) {
    window.requestAnimationFrame(() => {
      const viewport = state.historyViewport;
      if (!viewport) {
        return;
      }

      const previousScrollTop = viewport.scrollTop;
      viewport.scrollTop = viewport.scrollHeight;

      if (
        entries.length > HISTORY_VIRTUALIZE_AFTER &&
        Math.abs(viewport.scrollTop - previousScrollTop) > 1
      ) {
        scheduleHistoryRender(sessionId);
      }

      const current = viewStates.get(sessionId);
      if (current) {
        current.historyAutoScrollPinned = true;
        current.historyLastScrollMetrics = readHistoryScrollMetrics(viewport);
        renderScrollToBottomControl(panel, current);
      }
    });
  }
}

function buildHistoryRenderPlan(
  entries: readonly LensHistoryEntry[],
  metrics: HistoryViewportMetrics,
  state: SessionLensViewState | undefined,
): HistoryRenderPlan {
  if (entries.length === 0) {
    return {
      emptyStateText: lensText('lens.emptyHistory', 'No history entries yet.'),
      topSpacerPx: 0,
      bottomSpacerPx: 0,
      visibleEntries: [],
    };
  }

  const virtualWindow = computeHistoryVirtualWindow(
    entries,
    metrics.scrollTop,
    metrics.clientHeight,
    metrics.clientWidth,
  );
  const remoteAverageHeight =
    entries.length > 0
      ? entries.reduce(
          (sum, entry) => sum + estimateHistoryEntryHeight(entry, metrics.clientWidth),
          0,
        ) / entries.length
      : 92;
  const remoteTopSpacerPx = Math.max(
    0,
    Math.round((state?.snapshot?.historyWindowStart ?? 0) * remoteAverageHeight),
  );
  const totalHistoryCount = state?.snapshot?.totalHistoryCount ?? entries.length;
  const historyWindowEnd = state?.snapshot?.historyWindowEnd ?? entries.length;
  const remoteBottomCount = Math.max(0, totalHistoryCount - historyWindowEnd);
  const remoteBottomSpacerPx = Math.max(0, Math.round(remoteBottomCount * remoteAverageHeight));

  return {
    emptyStateText: null,
    topSpacerPx: remoteTopSpacerPx + virtualWindow.topSpacerPx,
    bottomSpacerPx: remoteBottomSpacerPx + virtualWindow.bottomSpacerPx,
    visibleEntries: entries
      .slice(virtualWindow.start, virtualWindow.end)
      .map((entry, visibleIndex) => {
        const absoluteIndex = virtualWindow.start + visibleIndex;
        const cluster = resolveArtifactCluster(entries, absoluteIndex);
        return {
          key: entry.id,
          entry,
          cluster,
          signature: buildHistoryEntrySignature(entry, cluster, state),
        };
      }),
  };
}

function buildHistoryEntrySignature(
  entry: LensHistoryEntry,
  cluster: ArtifactClusterInfo | null,
  state: SessionLensViewState | undefined,
): string {
  const badgeLabel = resolveHistoryBadgeLabel(entry.kind, state?.snapshot?.provider);
  const attachmentToken = (entry.attachments ?? [])
    .map((attachment) =>
      [attachment.kind, attachment.displayName, attachment.path, attachment.mimeType ?? ''].join(
        ':',
      ),
    )
    .join('|');
  const actionToken = (entry.actions ?? [])
    .map((action) => [action.id, action.label, action.style, action.busyLabel ?? ''].join(':'))
    .join('|');
  const commandTailToken = (entry.commandOutputTail ?? []).join('\n');
  const clusterToken = cluster
    ? [cluster.position, cluster.label ?? '', cluster.count, cluster.onlyTools ? '1' : '0'].join(
        ':',
      )
    : '';

  return [
    entry.kind,
    entry.tone,
    badgeLabel,
    entry.title,
    entry.body,
    entry.meta,
    entry.pending ? '1' : '0',
    entry.live ? '1' : '0',
    entry.busyIndicator ? '1' : '0',
    entry.busyElapsedText ?? '',
    entry.turnDurationNote ? '1' : '0',
    entry.sourceItemType ?? '',
    entry.commandText ?? '',
    commandTailToken,
    attachmentToken,
    actionToken,
    clusterToken,
    state?.activationActionBusy === true && (entry.actions?.length ?? 0) > 0 ? 'busy' : 'idle',
  ].join('||');
}

function reconcileHistoryRenderPlan(
  sessionId: string,
  container: HTMLDivElement,
  plan: HistoryRenderPlan,
): void {
  const state = viewStates.get(sessionId);
  if (!state) {
    return;
  }

  if (plan.emptyStateText) {
    const emptyNode = ensureEmptyHistoryNode(state, plan.emptyStateText);
    syncOrderedChildren(container, [emptyNode]);
    state.historyRenderedNodes.clear();
    state.historyTopSpacer = null;
    state.historyBottomSpacer = null;
    return;
  }

  state.historyEmptyState = null;
  const nextChildren: HTMLElement[] = [];

  if (plan.topSpacerPx > 0) {
    nextChildren.push(ensureHistorySpacerNode(state, 'top', plan.topSpacerPx));
  } else {
    state.historyTopSpacer = null;
  }

  const visibleKeys = new Set<string>();
  for (const visibleEntry of plan.visibleEntries) {
    visibleKeys.add(visibleEntry.key);
    nextChildren.push(resolveRenderedHistoryNode(sessionId, state, visibleEntry));
  }

  pruneRenderedHistoryNodes(state, visibleKeys);

  if (plan.bottomSpacerPx > 0) {
    nextChildren.push(ensureHistorySpacerNode(state, 'bottom', plan.bottomSpacerPx));
  } else {
    state.historyBottomSpacer = null;
  }

  syncOrderedChildren(container, nextChildren);
}

function ensureEmptyHistoryNode(state: SessionLensViewState, text: string): HTMLDivElement {
  if (!state.historyEmptyState) {
    const empty = document.createElement('div');
    empty.className = 'agent-history-empty';
    state.historyEmptyState = empty;
  }

  state.historyEmptyState.textContent = text;
  return state.historyEmptyState;
}

function ensureHistorySpacerNode(
  state: SessionLensViewState,
  position: 'top' | 'bottom',
  heightPx: number,
): HTMLDivElement {
  const existing = position === 'top' ? state.historyTopSpacer : state.historyBottomSpacer;
  const spacer = existing ?? (createHistorySpacer(0) as HTMLDivElement);
  spacer.style.height = `${Math.max(0, Math.round(heightPx))}px`;

  if (position === 'top') {
    state.historyTopSpacer = spacer;
  } else {
    state.historyBottomSpacer = spacer;
  }

  return spacer;
}

function resolveRenderedHistoryNode(
  sessionId: string,
  state: SessionLensViewState,
  visibleEntry: HistoryVisibleEntry,
): HTMLElement {
  const existing = state.historyRenderedNodes.get(visibleEntry.key);
  if (existing && existing.signature === visibleEntry.signature) {
    return existing.node;
  }

  const node = createHistoryEntry(visibleEntry.entry, sessionId, visibleEntry.cluster);
  state.historyRenderedNodes.set(visibleEntry.key, {
    node,
    signature: visibleEntry.signature,
    entry: visibleEntry.entry,
    cluster: visibleEntry.cluster,
  });
  return node;
}

function pruneRenderedHistoryNodes(
  state: SessionLensViewState,
  visibleKeys: ReadonlySet<string>,
): void {
  for (const cacheKey of state.historyRenderedNodes.keys()) {
    if (!visibleKeys.has(cacheKey)) {
      state.historyRenderedNodes.delete(cacheKey);
    }
  }
}

function syncOrderedChildren(container: HTMLElement, nodes: readonly HTMLElement[]): void {
  let anchor = container.firstChild;
  for (const node of nodes) {
    if (anchor !== node) {
      container.insertBefore(node, anchor);
    } else {
      anchor = anchor.nextSibling;
      continue;
    }

    anchor = node.nextSibling;
  }

  while (container.childNodes.length > nodes.length) {
    container.removeChild(container.lastChild as ChildNode);
  }
}

function renderScrollToBottomControl(panel: HTMLDivElement, state: SessionLensViewState): void {
  const button = panel.querySelector<HTMLButtonElement>('[data-agent-field="scroll-to-bottom"]');
  if (!button) {
    return;
  }

  const shouldShow =
    !state.historyAutoScrollPinned &&
    state.historyEntries.length > 0 &&
    state.activationState !== 'failed';
  button.textContent = lensText('lens.scrollToBottom', 'Back to bottom');
  button.hidden = !shouldShow;
}

function scrollHistoryToBottom(sessionId: string, behavior: ScrollBehavior = 'auto'): void {
  const state = viewStates.get(sessionId);
  const viewport = state?.historyViewport;
  if (!state || !viewport) {
    return;
  }

  state.historyAutoScrollPinned = true;
  state.historyLastUserScrollIntentAt = 0;
  viewport.scrollTo({
    top: viewport.scrollHeight,
    behavior,
  });
  state.historyLastScrollMetrics = readHistoryScrollMetrics(viewport);
  renderScrollToBottomControl(state.panel, state);
}

function renderComposerInterruption(
  panel: HTMLDivElement,
  sessionId: string,
  requests: readonly LensPulseRequestSummary[],
  state: SessionLensViewState,
): void {
  const host = panel.querySelector<HTMLElement>('[data-agent-field="composer-interruption"]');
  if (!host) {
    return;
  }

  const activeRequest = findActiveComposerRequest(requests);
  if (!activeRequest) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }

  host.hidden = false;
  host.replaceChildren(
    createRequestActionBlock(
      sessionId,
      activeRequest,
      busyRequestIdsForRender(activeRequest, state.requestBusyIds),
      state,
    ),
  );
}

function busyRequestIdsForRender(
  request: LensPulseRequestSummary,
  busyRequestIds: ReadonlySet<string>,
): boolean {
  return busyRequestIds.has(request.requestId);
}

function findActiveComposerRequest(
  requests: readonly LensPulseRequestSummary[],
): LensPulseRequestSummary | null {
  const openRequests = requests.filter((request) => request.state === 'open');
  if (openRequests.length === 0) {
    return null;
  }

  return (
    openRequests
      .slice()
      .sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      )[0] ?? null
  );
}

function syncRequestInteractionState(
  state: SessionLensViewState,
  requests: readonly LensPulseRequestSummary[],
): void {
  const activeRequestIds = new Set(
    requests.filter((request) => request.state === 'open').map((request) => request.requestId),
  );

  for (const requestId of Object.keys(state.requestDraftAnswersById)) {
    if (!activeRequestIds.has(requestId)) {
      Reflect.deleteProperty(state.requestDraftAnswersById, requestId);
    }
  }

  for (const requestId of Object.keys(state.requestQuestionIndexById)) {
    if (!activeRequestIds.has(requestId)) {
      Reflect.deleteProperty(state.requestQuestionIndexById, requestId);
    }
  }

  for (const request of requests) {
    if (request.state !== 'open') {
      continue;
    }

    ensureRequestDraftAnswers(state, request);
    const questionCount = Math.max(request.questions.length - 1, 0);
    const currentIndex = state.requestQuestionIndexById[request.requestId] ?? 0;
    state.requestQuestionIndexById[request.requestId] = Math.max(
      0,
      Math.min(currentIndex, questionCount),
    );
  }
}

function ensureRequestDraftAnswers(
  state: SessionLensViewState,
  request: LensPulseRequestSummary,
): Record<string, string[]> {
  const existing = state.requestDraftAnswersById[request.requestId];
  if (existing) {
    for (const question of request.questions) {
      if (!existing[question.id]) {
        existing[question.id] = resolveInitialQuestionAnswers(request, question.id);
      }
    }

    return existing;
  }

  const nextDraft: Record<string, string[]> = {};
  for (const question of request.questions) {
    nextDraft[question.id] = resolveInitialQuestionAnswers(request, question.id);
  }

  state.requestDraftAnswersById[request.requestId] = nextDraft;
  return nextDraft;
}

function resolveInitialQuestionAnswers(
  request: LensPulseRequestSummary,
  questionId: string,
): string[] {
  const answered = request.answers.find((answer) => answer.questionId === questionId);
  return answered?.answers.slice() ?? [];
}

function readHistoryViewportMetrics(container: HTMLDivElement): HistoryViewportMetrics {
  return {
    scrollTop: container.scrollTop,
    clientHeight: container.clientHeight,
    clientWidth: container.clientWidth,
  };
}

function readHistoryScrollMetrics(container: HTMLDivElement): HistoryScrollMetrics {
  return {
    scrollTop: container.scrollTop,
    clientHeight: container.clientHeight,
    scrollHeight: container.scrollHeight,
  };
}

/**
 * Normalizes the backend-owned Lens snapshot plus event stream into stable
 * conversation history so the frontend can stay a thin presentation layer.
 */
export function buildLensHistoryEntries(
  snapshot: LensPulseSnapshotResponse,
  _events: LensPulseEvent[],
): LensHistoryEntry[] {
  return buildCanonicalSnapshotHistoryEntries(snapshot);
}

function buildCanonicalSnapshotHistoryEntries(
  snapshot: LensPulseSnapshotResponse,
): LensHistoryEntry[] {
  // The backend wire contract still exposes `snapshot.transcript`. Treat that
  // legacy field as canonical Lens history in the frontend.
  const historyEntries = Array.isArray(snapshot.transcript) ? snapshot.transcript : [];
  if (historyEntries.length === 0) {
    return [];
  }

  return historyEntries
    .map(mapSnapshotEntryToHistoryEntry)
    .filter((entry) => !isSuppressedLensRuntimeNoticeEntry(entry))
    .sort((left, right) => left.order - right.order)
    .reduce<LensHistoryEntry[]>(mergeCommandHistoryEntries, [])
    .filter(
      (entry) =>
        entry.body.trim() ||
        (entry.commandText?.trim() ?? '').length > 0 ||
        (entry.attachments?.length ?? 0) > 0 ||
        entry.kind === 'request' ||
        entry.kind === 'system' ||
        entry.kind === 'notice',
    );
}

export function buildLensRuntimeStats(
  snapshot: LensPulseSnapshotResponse,
): LensRuntimeStatsSummary | null {
  const stats: LensRuntimeStatsSummary = {
    windowUsedTokens: null,
    windowTokenLimit: null,
    accumulatedInputTokens: 0,
    accumulatedOutputTokens: 0,
    primaryRateLimitUsedPercent: null,
    secondaryRateLimitUsedPercent: null,
  };
  let hasStats = false;
  const sources =
    snapshot.notices.length > 0
      ? snapshot.notices
      : snapshot.transcript
          .filter((entry) => isSuppressedLensRuntimeNoticeHistoryEntry(entry))
          .map<LensPulseRuntimeNotice>((entry) => ({
            eventId: entry.entryId,
            type: entry.kind,
            message: entry.title ?? '',
            detail: entry.body,
            createdAt: entry.updatedAt,
          }));

  for (const notice of sources) {
    const contextWindow = parseCodexContextWindowNotice(notice);
    if (contextWindow) {
      stats.windowUsedTokens = contextWindow.usedTokens;
      stats.windowTokenLimit = contextWindow.windowTokens;
      stats.accumulatedInputTokens += contextWindow.lastTurnInputTokens;
      stats.accumulatedOutputTokens += contextWindow.lastTurnOutputTokens;
      hasStats = true;
      continue;
    }

    const rateLimits = parseCodexRateLimitNotice(notice);
    if (rateLimits) {
      stats.primaryRateLimitUsedPercent = rateLimits.primaryUsedPercent;
      stats.secondaryRateLimitUsedPercent = rateLimits.secondaryUsedPercent;
      hasStats = true;
    }
  }

  return hasStats ? stats : null;
}

function mapSnapshotEntryToHistoryEntry(entry: LensPulseHistoryEntry): LensHistoryEntry {
  const kind = normalizeSnapshotHistoryKind(entry.kind);
  const statusLabel = entry.streaming
    ? lensText('lens.status.streaming', 'Streaming')
    : prettify(entry.status || kind);
  const mapped: LensHistoryEntry = {
    id: entry.entryId,
    order: entry.order,
    kind,
    tone: toneFromState(entry.status),
    label: historyLabel(kind),
    title: entry.title || '',
    body: entry.body || '',
    meta: resolveHistoryEntryMeta(entry, kind, statusLabel),
    attachments: cloneHistoryAttachments(entry.attachments),
    live: entry.streaming,
    sourceItemId: entry.itemId ?? null,
    sourceTurnId: entry.turnId ?? null,
    sourceItemType: entry.itemType ?? null,
  };
  if (entry.requestId) {
    mapped.requestId = entry.requestId;
  }

  applyDirectCommandPresentation(mapped);

  return mapped;
}

function resolveHistoryEntryMeta(
  entry: LensPulseHistoryEntry,
  kind: HistoryKind,
  statusLabel: string,
): string {
  if (kind === 'diff' || isCommandExecutionSnapshotEntry(entry)) {
    return '';
  }

  return formatHistoryMeta(kind, statusLabel, entry.updatedAt);
}

function isCommandExecutionSnapshotEntry(
  entry: Pick<LensPulseHistoryEntry, 'kind' | 'itemType'>,
): boolean {
  return (
    normalizeSnapshotHistoryKind(entry.kind) === 'tool' &&
    normalizeComparableHistoryText(entry.itemType ?? '').replace(/[_-]+/g, ' ') ===
      'command execution'
  );
}

function mergeCommandHistoryEntries(
  mergedEntries: LensHistoryEntry[],
  entry: LensHistoryEntry,
): LensHistoryEntry[] {
  if (!isCommandOutputHistoryEntry(entry)) {
    mergedEntries.push(entry);
    return mergedEntries;
  }

  const targetIndex = findCommandHistoryMergeTargetIndex(mergedEntries, entry);
  if (targetIndex < 0) {
    mergedEntries.push(entry);
    return mergedEntries;
  }

  const targetEntry = mergedEntries[targetIndex];
  if (!targetEntry) {
    mergedEntries.push(entry);
    return mergedEntries;
  }

  const commandPresentation = resolveCommandPresentation(entry);
  if (!commandPresentation) {
    return mergedEntries;
  }

  mergedEntries[targetIndex] = {
    ...targetEntry,
    commandText: targetEntry.commandText ?? commandPresentation.commandText,
    commandOutputTail: commandPresentation.commandOutputTail,
  };
  return mergedEntries;
}

function findCommandHistoryMergeTargetIndex(
  mergedEntries: LensHistoryEntry[],
  entry: LensHistoryEntry,
): number {
  for (let index = mergedEntries.length - 1; index >= 0; index -= 1) {
    const candidate = mergedEntries[index];
    if (!candidate) {
      continue;
    }

    if (!isCommandExecutionHistoryEntry(candidate)) {
      continue;
    }

    const sameSourceItem =
      candidate.sourceItemId && entry.sourceItemId && candidate.sourceItemId === entry.sourceItemId;
    if (sameSourceItem || candidate.id === entry.id) {
      return index;
    }
  }

  const previousEntry = mergedEntries[mergedEntries.length - 1];
  return previousEntry && isCommandExecutionHistoryEntry(previousEntry)
    ? mergedEntries.length - 1
    : -1;
}

function applyDirectCommandPresentation(entry: LensHistoryEntry): void {
  const commandPresentation = resolveCommandPresentation(entry);
  if (!commandPresentation) {
    return;
  }

  entry.commandText = commandPresentation.commandText;
  entry.commandOutputTail = commandPresentation.commandOutputTail;
}

function resolveCommandPresentation(
  entry: Pick<LensHistoryEntry, 'body' | 'commandOutputTail' | 'commandText' | 'sourceItemType'>,
): { commandText: string; commandOutputTail: string[] } | null {
  const normalizedType = normalizeHistoryItemType(entry.sourceItemType);
  if (normalizedType === 'commandexecution') {
    const commandText = (entry.commandText ?? entry.body).trim();
    return commandText ? { commandText, commandOutputTail: entry.commandOutputTail ?? [] } : null;
  }

  if (normalizedType !== 'commandoutput') {
    return null;
  }

  const parsed = parseCommandOutputBody(entry.body);
  if (!parsed) {
    return null;
  }

  return {
    commandText: parsed.commandText,
    commandOutputTail: parsed.commandOutputTail,
  };
}

export function isSuppressedLensRuntimeNoticeEntry(
  entry: Pick<LensHistoryEntry, 'kind' | 'title' | 'body'>,
): boolean {
  return isSuppressedLensRuntimeNoticeHistoryEntry({
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
  });
}

function isSuppressedLensRuntimeNoticeHistoryEntry(
  entry: Pick<LensPulseHistoryEntry, 'kind' | 'title' | 'body'>,
): boolean {
  if (!['system', 'notice'].includes(normalizeSnapshotHistoryKind(entry.kind))) {
    return false;
  }

  const title = normalizeComparableHistoryText(entry.title ?? '');
  const body = normalizeComparableHistoryText(entry.body);
  const contextMarker = normalizeComparableHistoryText('Codex context window updated.');
  const rateLimitMarker = normalizeComparableHistoryText('Codex rate limits updated.');
  return (
    title === contextMarker ||
    body === contextMarker ||
    title === rateLimitMarker ||
    body === rateLimitMarker ||
    body.includes(normalizeComparableHistoryText('last turn in/out')) ||
    body.includes('"ratelimits"') ||
    body.includes('"usedpercent"')
  );
}

function parseCodexContextWindowNotice(
  notice: Pick<LensPulseRuntimeNotice, 'message' | 'detail'>,
): {
  usedTokens: number;
  windowTokens: number;
  lastTurnInputTokens: number;
  lastTurnOutputTokens: number;
} | null {
  const message = normalizeComparableHistoryText(notice.message);
  const detail = notice.detail ?? '';
  if (
    message !== normalizeComparableHistoryText('Codex context window updated.') &&
    !normalizeComparableHistoryText(detail).includes(
      normalizeComparableHistoryText('last turn in/out'),
    )
  ) {
    return null;
  }

  const match = detail.match(
    /Used\s+(\d+)\s+tokens,\s+window\s+(\d+),\s+last turn in\/out\s+(\d+)\/(\d+)/i,
  );
  if (!match) {
    return null;
  }

  const [, usedTokensText, windowTokensText, inputTokensText, outputTokensText] = match;
  if (!usedTokensText || !windowTokensText || !inputTokensText || !outputTokensText) {
    return null;
  }

  return {
    usedTokens: Number.parseInt(usedTokensText, 10),
    windowTokens: Number.parseInt(windowTokensText, 10),
    lastTurnInputTokens: Number.parseInt(inputTokensText, 10),
    lastTurnOutputTokens: Number.parseInt(outputTokensText, 10),
  };
}

function parseCodexRateLimitNotice(
  notice: Pick<LensPulseRuntimeNotice, 'message' | 'detail'>,
): { primaryUsedPercent: number | null; secondaryUsedPercent: number | null } | null {
  if (
    normalizeComparableHistoryText(notice.message) !==
      normalizeComparableHistoryText('Codex rate limits updated.') ||
    !notice.detail
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(notice.detail) as {
      rateLimits?: {
        primary?: { usedPercent?: number | null };
        secondary?: { usedPercent?: number | null };
      };
    };
    return {
      primaryUsedPercent:
        typeof parsed.rateLimits?.primary?.usedPercent === 'number'
          ? parsed.rateLimits.primary.usedPercent
          : null,
      secondaryUsedPercent:
        typeof parsed.rateLimits?.secondary?.usedPercent === 'number'
          ? parsed.rateLimits.secondary.usedPercent
          : null,
    };
  } catch {
    return null;
  }
}

/**
 * Keeps the conversation responsive while the canonical Lens snapshot catches
 * up, so submitted turns feel immediate even though authority stays server-side.
 */
export function applyOptimisticLensTurns(
  snapshot: LensPulseSnapshotResponse,
  entries: readonly LensHistoryEntry[],
  optimisticTurns: readonly PendingLensTurn[],
): {
  entries: LensHistoryEntry[];
  optimisticTurns: PendingLensTurn[];
} {
  if (optimisticTurns.length === 0) {
    return {
      entries: [...entries],
      optimisticTurns: [],
    };
  }

  const optimisticEntries = [...entries];
  const remainingTurns: PendingLensTurn[] = [];
  let nextOrder =
    optimisticEntries.reduce((maxOrder, entry) => Math.max(maxOrder, entry.order), 0) + 1;

  for (const turn of optimisticTurns) {
    const userCommitted =
      turn.turnId !== null && optimisticEntries.some((entry) => entry.id === `user:${turn.turnId}`);
    const assistantCommitted =
      (turn.turnId !== null &&
        optimisticEntries.some((entry) => entry.id === `assistant:${turn.turnId}`)) ||
      (turn.turnId !== null &&
        snapshot.currentTurn.turnId === turn.turnId &&
        Boolean(snapshot.streams.assistantText.trim()));

    if (!userCommitted) {
      optimisticEntries.push({
        id: `optimistic-user:${turn.optimisticId}`,
        order: nextOrder,
        kind: 'user',
        tone: 'info',
        label: historyLabel('user'),
        title: '',
        body: turn.text,
        meta: formatHistoryMeta(
          'user',
          turn.status === 'submitted' ? 'Sending' : 'Sent',
          turn.submittedAt,
        ),
        attachments: cloneHistoryAttachments(turn.attachments),
        pending: turn.status === 'submitted',
      });
      nextOrder += 1;
    }

    if (!assistantCommitted) {
      optimisticEntries.push({
        id: `optimistic-assistant:${turn.optimisticId}`,
        order: nextOrder,
        kind: 'assistant',
        tone: 'info',
        label: historyLabel('assistant'),
        title: '',
        body: turn.status === 'submitted' ? 'Starting…' : 'Thinking…',
        meta: formatHistoryMeta(
          'assistant',
          turn.status === 'submitted' ? 'Starting' : 'Running',
          turn.submittedAt,
        ),
        live: true,
        pending: turn.status === 'submitted',
      });
      nextOrder += 1;
    }

    if (!userCommitted || !assistantCommitted) {
      remainingTurns.push(turn);
    }
  }

  return {
    entries: optimisticEntries.sort((left, right) => left.order - right.order),
    optimisticTurns: remainingTurns,
  };
}

function withInlineLensStatus(
  snapshot: LensPulseSnapshotResponse,
  entries: LensHistoryEntry[],
  streamConnected: boolean,
): LensHistoryEntry[] {
  const hasConversation = entries.some((entry) =>
    ['user', 'assistant', 'tool', 'request', 'plan', 'diff'].includes(entry.kind),
  );
  const statusBody =
    snapshot.session.lastError?.trim() ||
    snapshot.session.reason?.trim() ||
    (streamConnected
      ? lensText(
          'lens.status.connectedWaiting',
          'Lens is connected to MidTerm and waiting for history content.',
        )
      : lensText('lens.status.reconnecting', 'Lens is reconnecting to MidTerm.'));

  if ((!statusBody || hasConversation) && !snapshot.session.lastError) {
    return entries;
  }

  return [
    {
      id: 'midterm-status',
      order: Number.MIN_SAFE_INTEGER,
      kind: snapshot.session.lastError ? 'notice' : 'system',
      tone: snapshot.session.lastError ? 'attention' : streamConnected ? 'positive' : 'warning',
      label: lensText('lens.label.midterm', 'MidTerm'),
      title: '',
      body: statusBody,
      meta: streamConnected ? '' : lensText('lens.status.connecting', 'Connecting'),
    },
    ...entries,
  ];
}

/**
 * Promotes the trailing assistant entry into a streaming state when the current
 * turn is still running, which restores the "live response" feel users expect.
 */
export function withLiveAssistantState(
  snapshot: LensPulseSnapshotResponse,
  entries: LensHistoryEntry[],
): LensHistoryEntry[] {
  if (snapshot.currentTurn.state !== 'running' && snapshot.currentTurn.state !== 'in_progress') {
    return entries;
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.kind !== 'assistant') {
      continue;
    }

    return entries.map((candidate, candidateIndex) =>
      candidateIndex === index ? { ...candidate, live: true } : candidate,
    );
  }

  return entries;
}

export function withTrailingBusyIndicator(
  snapshot: LensPulseSnapshotResponse,
  entries: LensHistoryEntry[],
  requests: readonly LensPulseRequestSummary[],
): LensHistoryEntry[] {
  if (!shouldShowTrailingBusyIndicator(snapshot, requests)) {
    return entries.filter((entry) => !entry.busyIndicator);
  }

  const nextEntries = entries.filter((entry) => !entry.busyIndicator);
  const lastOrder = nextEntries.reduce((maxOrder, entry) => Math.max(maxOrder, entry.order), 0);
  nextEntries.push({
    id: `busy-indicator:${snapshot.currentTurn.turnId ?? snapshot.session.lastEventAt ?? 'current'}`,
    order: lastOrder + 1,
    kind: 'assistant',
    tone: 'info',
    label: historyLabel('assistant'),
    title: '',
    body: resolveTrailingBusyIndicatorLabel(snapshot, nextEntries),
    meta: '',
    busyIndicator: true,
    busyElapsedText: formatLensTurnDuration(resolveBusyIndicatorElapsedMs(snapshot)),
  });
  return nextEntries;
}

function shouldShowTrailingBusyIndicator(
  snapshot: LensPulseSnapshotResponse,
  requests: readonly LensPulseRequestSummary[],
): boolean {
  const currentTurnState = (snapshot.currentTurn.state || '').toLowerCase();
  const sessionState = (snapshot.session.state || '').toLowerCase();
  const waitingOnUser = requests.some((request) => request.state === 'open');
  if (waitingOnUser) {
    return false;
  }

  return (
    currentTurnState === 'running' ||
    currentTurnState === 'in_progress' ||
    (currentTurnState.length === 0 && (sessionState === 'starting' || sessionState === 'running'))
  );
}

function resolveTrailingBusyIndicatorLabel(
  snapshot: LensPulseSnapshotResponse,
  entries: readonly LensHistoryEntry[],
): string {
  void entries;
  const providerBusyLabel = resolveBusyIndicatorLabelFromSnapshotItems(snapshot);
  if (providerBusyLabel) {
    return providerBusyLabel;
  }

  return lensText('lens.status.working', 'Working');
}

function resolveBusyIndicatorElapsedMs(snapshot: LensPulseSnapshotResponse): number | null {
  const startedAt = resolveTurnStartIso(snapshot);
  if (!startedAt) {
    return null;
  }

  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) {
    return null;
  }

  return Math.max(0, Date.now() - startMs);
}

function resolveTurnStartIso(snapshot: LensPulseSnapshotResponse): string | null {
  if (snapshot.currentTurn.startedAt) {
    return snapshot.currentTurn.startedAt;
  }

  const currentTurnId = snapshot.currentTurn.turnId ?? null;
  const transcriptEntries = Array.isArray(snapshot.transcript) ? snapshot.transcript : [];
  const matchingUserEntry = [...transcriptEntries]
    .reverse()
    .find(
      (entry) =>
        normalizeSnapshotHistoryKind(entry.kind) === 'user' &&
        (!currentTurnId || !entry.turnId || entry.turnId === currentTurnId),
    );
  return matchingUserEntry?.createdAt ?? null;
}

function resolveBusyIndicatorLabelFromSnapshotItems(
  snapshot: LensPulseSnapshotResponse,
): string | null {
  const currentTurnId = snapshot.currentTurn.turnId ?? null;
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const candidates = items
    .filter((item) => isLiveBusyIndicatorItem(item, currentTurnId))
    .sort(compareBusyIndicatorItemsNewestFirst);

  for (const item of candidates) {
    const detailLabel = normalizeBusyIndicatorLabel(item.detail ?? '');
    if (detailLabel) {
      return detailLabel;
    }

    const titleLabel = normalizeBusyIndicatorLabel(item.title ?? '');
    if (titleLabel && !isGenericBusyIndicatorTitle(titleLabel, item.itemType)) {
      return titleLabel;
    }
  }

  return null;
}

function isLiveBusyIndicatorItem(
  item: LensPulseSnapshotResponse['items'][number],
  currentTurnId: string | null,
): boolean {
  const status = item.status.trim().toLowerCase();
  if (!['in_progress', 'running', 'started'].includes(status)) {
    return false;
  }

  if (currentTurnId && item.turnId && item.turnId !== currentTurnId) {
    return false;
  }

  const itemType = normalizeComparableHistoryText(item.itemType);
  return itemType !== 'assistant_message' && itemType !== 'user_message';
}

function compareBusyIndicatorItemsNewestFirst(
  left: LensPulseSnapshotResponse['items'][number],
  right: LensPulseSnapshotResponse['items'][number],
): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function normalizeBusyIndicatorLabel(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return '';
  }

  const singleLine = collapsed.replace(/[`*_#>]+/g, '').trim();
  if (!singleLine) {
    return '';
  }

  return singleLine.length > 72 ? `${singleLine.slice(0, 69).trimEnd()}...` : singleLine;
}

function isGenericBusyIndicatorTitle(value: string, itemType: string): boolean {
  const normalizedValue = normalizeComparableHistoryText(value);
  const normalizedItemType = normalizeComparableHistoryText(itemType).replace(/[_-]+/g, ' ');
  return (
    normalizedValue === normalizedItemType ||
    normalizedValue === prettify(itemType).toLowerCase() ||
    normalizedValue.endsWith(' started') ||
    normalizedValue.endsWith(' updated') ||
    normalizedValue.endsWith(' running')
  );
}

function withTurnDurationNotes(
  snapshot: LensPulseSnapshotResponse,
  entries: LensHistoryEntry[],
  state: SessionLensViewState,
): LensHistoryEntry[] {
  rememberCompletedTurnDurationEntry(snapshot, state);
  if (state.completedTurnDurationEntries.size === 0) {
    return entries;
  }

  const nextEntries = [...entries];
  for (const durationEntry of state.completedTurnDurationEntries.values()) {
    const insertionOrder = resolveTurnDurationInsertionOrder(entries, durationEntry.sourceTurnId);
    if (insertionOrder === null) {
      continue;
    }

    nextEntries.push({
      ...durationEntry,
      order: insertionOrder + 0.01,
    });
  }

  return nextEntries.sort((left, right) => left.order - right.order);
}

function rememberCompletedTurnDurationEntry(
  snapshot: LensPulseSnapshotResponse,
  state: SessionLensViewState,
): void {
  const turnId = snapshot.currentTurn.turnId ?? null;
  if (!turnId || state.completedTurnDurationEntries.has(turnId)) {
    return;
  }

  const currentTurnState = normalizeComparableHistoryText(snapshot.currentTurn.state || '');
  if (currentTurnState === 'running' || currentTurnState === 'in progress') {
    return;
  }

  const startedAt = resolveTurnStartIso(snapshot);
  const completedAt = snapshot.currentTurn.completedAt || snapshot.generatedAt;
  if (!startedAt || !completedAt) {
    return;
  }

  const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return;
  }

  state.completedTurnDurationEntries.set(turnId, {
    id: `turn-duration:${turnId}`,
    order: Number.MAX_SAFE_INTEGER,
    kind: 'system',
    tone: 'info',
    label: '',
    title: '',
    body: `(Turn took ${formatLensTurnDuration(durationMs)})`,
    meta: '',
    sourceTurnId: turnId,
    turnDurationNote: true,
  });
  pruneCompletedTurnDurationEntries(state);
}

function resolveTurnDurationInsertionOrder(
  entries: readonly LensHistoryEntry[],
  turnId: string | null | undefined,
): number | null {
  const matchingEntries = entries.filter((entry) => !turnId || entry.sourceTurnId === turnId);
  if (matchingEntries.length === 0) {
    return null;
  }

  return matchingEntries.reduce(
    (maxOrder, entry) => Math.max(maxOrder, entry.order),
    Number.MIN_SAFE_INTEGER,
  );
}

function pruneCompletedTurnDurationEntries(state: SessionLensViewState): void {
  const turnIds = [...state.completedTurnDurationEntries.keys()];
  if (turnIds.length <= 64) {
    return;
  }

  for (const turnId of turnIds.slice(0, turnIds.length - 64)) {
    state.completedTurnDurationEntries.delete(turnId);
  }
}

function syncBusyIndicatorTicker(
  snapshot: LensPulseSnapshotResponse,
  state: SessionLensViewState,
  entries: readonly LensHistoryEntry[],
): void {
  const hasBusyIndicator = entries.some((entry) => entry.busyIndicator);
  if (!hasBusyIndicator) {
    if (state.busyIndicatorTickHandle !== null) {
      window.clearTimeout(state.busyIndicatorTickHandle);
      state.busyIndicatorTickHandle = null;
    }

    return;
  }

  if (state.busyIndicatorTickHandle !== null) {
    return;
  }

  state.busyIndicatorTickHandle = window.setTimeout(() => {
    const current = viewStates.get(snapshot.sessionId);
    if (!current) {
      return;
    }

    current.busyIndicatorTickHandle = null;
    renderCurrentAgentView(snapshot.sessionId, { immediate: true });
  }, 1000);
}

/**
 * Surfaces attach and handoff failures inside the conversation lane so users
 * understand why Lens fell back instead of hunting through separate chrome.
 */
export function withActivationIssueNotice(
  entries: LensHistoryEntry[],
  issue: LensActivationIssue | null,
): LensHistoryEntry[] {
  if (!issue) {
    return entries;
  }

  return [
    {
      id: `lens-issue:${issue.kind}`,
      order: Number.MIN_SAFE_INTEGER,
      kind: issue.tone === 'attention' ? 'notice' : 'system',
      tone: issue.tone,
      label: lensText('lens.label.midterm', 'MidTerm'),
      title: issue.title,
      body: issue.body,
      meta: issue.meta,
      actions: issue.actions,
    },
    ...entries,
  ];
}

/**
 * Renders Lens attach and recovery progress as history entries so the user
 * sees handoff progress in the same place they expect the conversation to live.
 */
export function buildActivationHistoryEntries(state: SessionLensViewState): LensHistoryEntry[] {
  if (state.activationTrace.length === 0) {
    return [
      {
        id: 'activation:pending',
        order: 0,
        kind: 'system',
        tone: state.activationState === 'failed' ? 'attention' : 'warning',
        label: lensText('lens.label.midterm', 'MidTerm'),
        title: '',
        body: state.activationDetail || 'Waiting for Lens boot steps…',
        meta:
          state.activationState === 'failed'
            ? lensText('lens.status.failed', 'Failed')
            : lensText('lens.status.connecting', 'Connecting'),
      },
    ];
  }

  const traceEntries = shouldCompactActivationTrace(state.activationIssue)
    ? state.activationTrace.filter((entry) => entry.tone !== 'attention').slice(-2)
    : state.activationTrace;

  const entries: LensHistoryEntry[] = traceEntries.map((entry, index) => ({
    id: `activation:${index}`,
    order: index,
    kind: entry.tone === 'attention' ? ('notice' as const) : ('system' as const),
    tone: entry.tone,
    label: lensText('lens.label.midterm', 'MidTerm'),
    title: '',
    body: entry.detail,
    meta: entry.meta,
  }));

  return entries;
}

function shouldCompactActivationTrace(issue: LensActivationIssue | null): boolean {
  return (
    issue?.kind === 'busy-terminal-turn' ||
    issue?.kind === 'missing-resume-id' ||
    issue?.kind === 'shell-recovery-failed' ||
    issue?.kind === 'native-runtime-unavailable'
  );
}

function createHistoryEntry(
  entry: LensHistoryEntry,
  sessionId: string,
  artifactCluster: ArtifactClusterInfo | null = null,
): HTMLElement {
  if (entry.busyIndicator) {
    return createBusyIndicatorEntry(entry);
  }

  const article = document.createElement('article');
  article.className = `agent-history-entry agent-history-${entry.kind} agent-history-${entry.tone}`;
  article.dataset.kind = entry.kind;
  article.dataset.tone = entry.tone;
  if (artifactCluster) {
    article.dataset.artifactPosition = artifactCluster.position;
    article.classList.add('agent-history-artifact');
  }
  if (entry.pending) {
    article.dataset.pending = 'true';
    article.classList.add('agent-history-pending');
  }
  if (entry.live) {
    article.dataset.live = 'true';
    article.classList.add('agent-history-live');
  }
  if (entry.turnDurationNote) {
    article.dataset.turnDurationNote = 'true';
    article.classList.add('agent-history-turn-duration');
  }
  if (entry.kind === 'assistant' && isAssistantPlaceholderEntry(entry)) {
    article.dataset.placeholder = 'true';
    article.classList.add('agent-history-assistant-placeholder');
  }

  if (artifactCluster?.label) {
    article.appendChild(createArtifactClusterLabel(artifactCluster));
  }

  const header = document.createElement('div');
  header.className = 'agent-history-header';

  const badge = document.createElement('span');
  badge.className = `agent-history-badge agent-history-badge-${entry.kind}`;
  badge.textContent = resolveHistoryBadgeLabel(
    entry.kind,
    viewStates.get(sessionId)?.snapshot?.provider,
  );

  const meta = document.createElement('div');
  meta.className = 'agent-history-meta';
  meta.textContent = entry.meta;

  header.appendChild(badge);
  if (entry.meta.trim()) {
    header.appendChild(meta);
  }
  article.appendChild(header);

  const titleText = normalizeHistoryTitle(entry);
  if (titleText) {
    const title = document.createElement('div');
    title.className = 'agent-history-title';
    title.textContent = titleText;
    article.appendChild(title);
  }

  if (shouldRenderHistoryBody(entry)) {
    const presentation = resolveHistoryBodyPresentation(entry);
    article.appendChild(
      presentation.collapsedByDefault
        ? createCollapsedHistoryBody(entry, sessionId, presentation)
        : createHistoryBodyContent(entry, sessionId, presentation),
    );
  }

  const attachmentBlock = createHistoryAttachmentBlock(sessionId, entry.attachments);
  if (attachmentBlock) {
    article.appendChild(attachmentBlock);
  }

  if (entry.actions && entry.actions.length > 0) {
    article.appendChild(createHistoryActionBlock(sessionId, entry.actions));
  }

  return article;
}

function createHistoryBodyContent(
  entry: LensHistoryEntry,
  sessionId: string,
  presentation: HistoryBodyPresentation,
): HTMLElement {
  switch (presentation.mode) {
    case 'command':
      return createCommandHistoryBody(entry);
    case 'streaming': {
      const body = document.createElement('div');
      body.className = 'agent-history-body';
      body.classList.add('agent-history-streaming-body');
      body.textContent = entry.body;
      return body;
    }
    case 'markdown': {
      const body = document.createElement('div');
      body.className = 'agent-history-body';
      body.classList.add('agent-history-markdown');
      const content = document.createElement('div');
      content.className = 'agent-history-markdown-content';
      content.innerHTML = getCachedAssistantMarkdownHtml(sessionId, entry);
      collapseSingleParagraphMarkdownBody(content);
      body.appendChild(content);
      return body;
    }
    case 'diff':
      return createDiffHistoryBody(entry.body, sessionId);
    case 'monospace': {
      const body = document.createElement('pre');
      body.className = 'agent-history-body';
      body.textContent = entry.body;
      return body;
    }
    default: {
      const body = document.createElement('div');
      body.className = 'agent-history-body';
      body.textContent = entry.body;
      return body;
    }
  }
}

function createCommandHistoryBody(entry: LensHistoryEntry): HTMLElement {
  const body = document.createElement('div');
  body.className = 'agent-history-body agent-history-command-body';

  const commandLine = document.createElement('div');
  commandLine.className = 'agent-history-command-line';

  const prefix = document.createElement('span');
  prefix.className = 'agent-history-command-prefix';
  prefix.textContent = 'Ran ';
  commandLine.appendChild(prefix);

  for (const token of tokenizeCommandText(entry.commandText ?? entry.body)) {
    const part = document.createElement('span');
    part.className = `agent-history-command-token agent-history-command-token-${token.kind}`;
    part.textContent = token.text;
    commandLine.appendChild(part);
  }

  body.appendChild(commandLine);

  if ((entry.commandOutputTail?.length ?? 0) > 0) {
    const output = document.createElement('pre');
    output.className = 'agent-history-command-output-tail';
    output.textContent = entry.commandOutputTail?.join('\n') ?? '';
    body.appendChild(output);
  }

  return body;
}

function createBusyIndicatorEntry(entry: LensHistoryEntry): HTMLElement {
  const article = document.createElement('article');
  article.className = 'agent-history-entry agent-history-assistant agent-history-busy-indicator';
  article.dataset.kind = 'assistant';
  article.dataset.busyIndicator = 'true';

  const bubble = document.createElement('div');
  bubble.className = 'agent-history-busy-bubble';

  const glyph = document.createElement('span');
  glyph.className = 'agent-history-busy-glyph';
  glyph.innerHTML =
    '<svg class="agent-history-busy-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<g class="agent-history-busy-spinner">' +
    '<path class="agent-history-busy-triangle" d="M12 3.75 20 18.25H4L12 3.75Z" />' +
    '<circle class="agent-history-busy-center" cx="12" cy="13" r="2.3" />' +
    '</g>' +
    '</svg>';

  const label = document.createElement('span');
  label.className = 'agent-history-busy-label';
  const busyLabel = entry.body || 'Working';
  for (const [index, character] of Array.from(busyLabel).entries()) {
    const letter = document.createElement('span');
    letter.className = 'agent-history-busy-label-letter';
    if (typeof letter.style.setProperty === 'function') {
      letter.style.setProperty('--agent-busy-letter-index', String(index));
    }
    letter.textContent = character;
    label.appendChild(letter);
  }

  const status = document.createElement('span');
  status.className = 'agent-history-busy-status';

  const elapsed = document.createElement('span');
  elapsed.className = 'agent-history-busy-elapsed';
  elapsed.textContent = entry.busyElapsedText ?? '0s';
  status.appendChild(elapsed);

  const cancelHint = document.createElement('span');
  cancelHint.className = 'agent-history-busy-cancel';
  cancelHint.textContent = '(Press Esc to cancel)';
  status.appendChild(cancelHint);

  bubble.appendChild(glyph);
  bubble.appendChild(label);
  bubble.appendChild(status);
  article.appendChild(bubble);
  return article;
}

function createDiffHistoryBody(bodyText: string, sessionId: string): HTMLElement {
  const body = document.createElement('div');
  body.className = 'agent-history-body agent-history-diff-body';

  const content = document.createElement('pre');
  content.className = 'agent-history-diff-content';

  for (const line of buildRenderedDiffLines(bodyText, resolveSessionWorkingDirectory(sessionId))) {
    const row = document.createElement('span');
    row.className = `agent-history-diff-line ${line.className}`;
    row.appendChild(createDiffLineNumberNode(line.oldLineNumber));
    row.appendChild(createDiffLineNumberNode(line.newLineNumber));

    const text = document.createElement('span');
    text.className = 'agent-history-diff-line-text';
    text.textContent = line.text || ' ';
    row.appendChild(text);
    content.appendChild(row);
  }

  body.appendChild(content);
  return body;
}

function createDiffLineNumberNode(value: number | undefined): HTMLElement {
  const cell = document.createElement('span');
  cell.className = 'agent-history-diff-line-number';
  if (typeof value === 'number' && Number.isFinite(value)) {
    cell.textContent = String(value);
  } else {
    cell.textContent = '';
    cell.setAttribute('aria-hidden', 'true');
  }

  return cell;
}

function resolveDiffLineClassName(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
    return 'agent-history-diff-line-header';
  }

  if (line.startsWith('@@')) {
    return 'agent-history-diff-line-hunk';
  }

  if (line.startsWith('+')) {
    return 'agent-history-diff-line-add';
  }

  if (line.startsWith('-')) {
    return 'agent-history-diff-line-delete';
  }

  return 'agent-history-diff-line-context';
}

export function buildRenderedDiffLines(
  bodyText: string,
  sessionCwd?: string | null,
): DiffRenderLine[] {
  const normalizedLines = normalizeHistoryBodyLines(bodyText);
  if (normalizedLines.length === 0) {
    return [];
  }

  const rendered = buildDiffSections(normalizedLines, sessionCwd);
  const lines = rendered.length > 0 ? rendered : buildFallbackDiffLines(normalizedLines);
  if (lines.length <= MAX_VISIBLE_DIFF_LINES) {
    return lines;
  }

  return [
    ...lines.slice(0, MAX_VISIBLE_DIFF_LINES),
    {
      text: lensFormat('lens.diff.omittedLines', '... {count} more diff lines omitted ...', {
        count: lines.length - MAX_VISIBLE_DIFF_LINES,
      }),
      className: 'agent-history-diff-line-ellipsis',
    },
  ];
}

interface ParsedDiffSection {
  oldPath: string;
  newPath: string;
  lines: string[];
  lineState: DiffLineState;
}

interface DiffLineState {
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

function buildDiffSections(lines: readonly string[], sessionCwd?: string | null): DiffRenderLine[] {
  const sections: ParsedDiffSection[] = [];
  let current: ParsedDiffSection | null = null;
  let seenHunk = false;

  const ensureCurrent = (): ParsedDiffSection => {
    if (current) {
      return current;
    }

    current = {
      oldPath: '',
      newPath: '',
      lines: [],
      lineState: {
        oldLineNumber: null,
        newLineNumber: null,
      },
    };
    sections.push(current);
    return current;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = {
        oldPath: extractDiffGitPath(line, 'a/'),
        newPath: extractDiffGitPath(line, 'b/'),
        lines: [],
        lineState: {
          oldLineNumber: null,
          newLineNumber: null,
        },
      };
      sections.push(current);
      seenHunk = false;
      continue;
    }

    const section = ensureCurrent();
    if (line.startsWith('--- ')) {
      section.oldPath = normalizeDiffPath(line.slice(4));
      continue;
    }

    if (line.startsWith('+++ ')) {
      section.newPath = normalizeDiffPath(line.slice(4));
      continue;
    }

    if (
      line.startsWith('index ') ||
      line.startsWith('new file mode ') ||
      line.startsWith('deleted file mode ') ||
      line.startsWith('old mode ') ||
      line.startsWith('new mode ') ||
      line.startsWith('similarity index ') ||
      line.startsWith('rename from ') ||
      line.startsWith('rename to ') ||
      line.startsWith('copy from ') ||
      line.startsWith('copy to ')
    ) {
      continue;
    }

    if (line.startsWith('@@')) {
      seenHunk = true;
      section.lines.push(line);
      continue;
    }

    if (
      line.startsWith('Binary files ') ||
      line.startsWith('GIT binary patch') ||
      line.startsWith('literal ') ||
      line.startsWith('delta ')
    ) {
      section.lines.push(line);
      continue;
    }

    if (!seenHunk && !section.lines.length) {
      continue;
    }

    section.lines.push(line);
  }

  const rendered: DiffRenderLine[] = [];
  for (const section of sections) {
    if (section.lines.length === 0) {
      continue;
    }

    const sectionHeader = formatDiffSectionHeader(section.oldPath, section.newPath, sessionCwd);
    if (sectionHeader) {
      rendered.push({
        text: sectionHeader,
        className: 'agent-history-diff-line-file',
      });
    }

    for (const line of section.lines) {
      rendered.push(...buildRenderedDiffChunk(section, line));
    }
  }

  return rendered;
}

function buildFallbackDiffLines(lines: readonly string[]): DiffRenderLine[] {
  const trimmedLines = lines.filter(
    (line) =>
      line.trim().length > 0 &&
      !line.startsWith('diff --git ') &&
      !line.startsWith('index ') &&
      !line.startsWith('new file mode ') &&
      !line.startsWith('deleted file mode ') &&
      !line.startsWith('old mode ') &&
      !line.startsWith('new mode '),
  );
  const source = trimmedLines.length > 0 ? trimmedLines : lines;
  return source.map((line) => ({
    text: line || ' ',
    className: resolveDiffLineClassName(line),
  }));
}

function buildRenderedDiffChunk(section: ParsedDiffSection, line: string): DiffRenderLine[] {
  const rendered: DiffRenderLine[] = [];
  const state = getOrCreateDiffLineState(section);

  if (line.startsWith('@@')) {
    applyDiffHunkHeader(state, line);
    rendered.push({
      text: line,
      className: resolveDiffLineClassName(line),
    });
    return rendered;
  }

  if (state.oldLineNumber === null && state.newLineNumber === null) {
    rendered.push({
      text: line || ' ',
      className: resolveDiffLineClassName(line),
    });
    return rendered;
  }

  if (line.startsWith('+')) {
    rendered.push(
      createDiffRenderLine(
        line,
        resolveDiffLineClassName(line),
        undefined,
        state.newLineNumber ?? undefined,
      ),
    );
    if (state.newLineNumber !== null) {
      state.newLineNumber += 1;
    }

    return rendered;
  }

  if (line.startsWith('-')) {
    rendered.push(
      createDiffRenderLine(line, resolveDiffLineClassName(line), state.oldLineNumber ?? undefined),
    );
    if (state.oldLineNumber !== null) {
      state.oldLineNumber += 1;
    }

    return rendered;
  }

  if (line.startsWith('\\')) {
    rendered.push({
      text: line,
      className: resolveDiffLineClassName(line),
    });
    return rendered;
  }

  rendered.push(
    createDiffRenderLine(
      line || ' ',
      resolveDiffLineClassName(line),
      state.oldLineNumber ?? undefined,
      state.newLineNumber ?? undefined,
    ),
  );
  if (state.oldLineNumber !== null) {
    state.oldLineNumber += 1;
  }

  if (state.newLineNumber !== null) {
    state.newLineNumber += 1;
  }

  return rendered;
}

function getOrCreateDiffLineState(section: ParsedDiffSection): DiffLineState {
  return section.lineState;
}

function applyDiffHunkHeader(state: DiffLineState, line: string): void {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) {
    state.oldLineNumber = null;
    state.newLineNumber = null;
    return;
  }

  state.oldLineNumber = Number.parseInt(match[1] || '0', 10);
  state.newLineNumber = Number.parseInt(match[2] || '0', 10);
}

function createDiffRenderLine(
  text: string,
  className: string,
  oldLineNumber?: number,
  newLineNumber?: number,
): DiffRenderLine {
  const line: DiffRenderLine = {
    text,
    className,
  };
  if (typeof oldLineNumber === 'number') {
    line.oldLineNumber = oldLineNumber;
  }

  if (typeof newLineNumber === 'number') {
    line.newLineNumber = newLineNumber;
  }

  return line;
}

function extractDiffGitPath(line: string, prefix: 'a/' | 'b/'): string {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!match) {
    return '';
  }

  return normalizeDiffPath(prefix === 'a/' ? `a/${match[1]}` : `b/${match[2]}`);
}

function normalizeDiffPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed === '/dev/null') {
    return trimmed;
  }

  return trimmed.replace(/^["']|["']$/g, '').replace(/^[ab]\//, '');
}

function formatDiffSectionHeader(
  oldPath: string,
  newPath: string,
  sessionCwd?: string | null,
): string {
  const normalizedOld = normalizeDiffPath(oldPath);
  const normalizedNew = normalizeDiffPath(newPath);
  const preferredPath =
    normalizedNew && normalizedNew !== '/dev/null' ? normalizedNew : normalizedOld;
  const displayPath = resolveDisplayDiffPath(preferredPath, sessionCwd);
  if (!normalizedOld && !normalizedNew) {
    return '';
  }

  if (normalizedOld === '/dev/null') {
    return displayPath ? `Edited ${displayPath}` : '';
  }

  if (normalizedNew === '/dev/null') {
    return lensFormat('lens.diff.deletedFile', 'Edited {path} (deleted)', {
      path: resolveDisplayDiffPath(normalizedOld, sessionCwd),
    });
  }

  if (!normalizedOld || normalizedOld === normalizedNew) {
    return displayPath ? `Edited ${displayPath}` : '';
  }

  return lensFormat('lens.diff.renamedFile', 'Edited {to} (from {from})', {
    from: resolveDisplayDiffPath(normalizedOld, sessionCwd),
    to: resolveDisplayDiffPath(normalizedNew, sessionCwd),
  });
}

function resolveSessionWorkingDirectory(sessionId: string): string | null {
  const cwd = getSession(sessionId)?.currentDirectory?.trim();
  return cwd && cwd.length > 0 ? cwd : null;
}

function resolveDisplayDiffPath(path: string, sessionCwd?: string | null): string {
  const normalizedPath = normalizeDiffPath(path);
  if (!normalizedPath || normalizedPath === '/dev/null') {
    return normalizedPath;
  }

  if (
    /^[A-Za-z]:[\\/]/.test(normalizedPath) ||
    normalizedPath.startsWith('/') ||
    normalizedPath.startsWith('\\\\')
  ) {
    return normalizedPath;
  }

  const cwd = (sessionCwd ?? '').trim();
  if (!cwd) {
    return normalizedPath;
  }

  return `${cwd.replace(/[\\/]+$/g, '')}\\${normalizedPath.replace(/\//g, '\\')}`;
}

function createCollapsedHistoryBody(
  entry: LensHistoryEntry,
  sessionId: string,
  presentation: HistoryBodyPresentation,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'agent-history-disclosure-shell';

  const details = document.createElement('details');
  details.className = 'agent-history-disclosure';
  details.open = isHistoryEntryExpanded(sessionId, entry.id);

  const summary = document.createElement('summary');
  summary.className = 'agent-history-disclosure-summary';

  const label = document.createElement('span');
  label.className = 'agent-history-disclosure-label';
  label.textContent = lensText('lens.panel.details', 'Details');
  summary.appendChild(label);

  const meta = document.createElement('span');
  meta.className = 'agent-history-disclosure-meta';
  meta.textContent = lensFormat('lens.panel.lines', '{count} lines', {
    count: presentation.lineCount,
  });
  summary.appendChild(meta);

  if (presentation.preview) {
    const preview = document.createElement('span');
    preview.className = 'agent-history-disclosure-preview';
    preview.textContent = presentation.preview;
    summary.appendChild(preview);
  }

  details.addEventListener('toggle', () => {
    const state = viewStates.get(sessionId);
    if (!state) {
      return;
    }

    if (details.open) {
      state.historyExpandedEntries.add(entry.id);
    } else {
      state.historyExpandedEntries.delete(entry.id);
    }
  });

  details.appendChild(summary);
  details.appendChild(createHistoryBodyContent(entry, sessionId, presentation));
  wrapper.appendChild(details);
  return wrapper;
}

function isHistoryEntryExpanded(sessionId: string, entryId: string): boolean {
  return viewStates.get(sessionId)?.historyExpandedEntries.has(entryId) === true;
}

function createArtifactClusterLabel(cluster: ArtifactClusterInfo): HTMLElement {
  const label = document.createElement('div');
  label.className = 'agent-history-artifact-cluster-label';
  label.textContent =
    cluster.count > 1
      ? lensFormat('lens.cluster.withCount', '{label} ({count})', {
          label: cluster.label || '',
          count: cluster.count,
        })
      : cluster.label || '';
  return label;
}

function createHistoryActionBlock(
  sessionId: string,
  actions: readonly LensHistoryAction[],
): HTMLElement {
  const state = viewStates.get(sessionId);
  const busy = state?.activationActionBusy === true;
  const row = document.createElement('div');
  row.className = 'agent-history-actions';

  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      action.style === 'primary' ? 'agent-view-btn agent-view-btn-primary' : 'agent-view-btn';
    button.disabled = busy;
    button.textContent = busy ? action.busyLabel || action.label : action.label;
    button.addEventListener('click', () => {
      void handleHistoryAction(sessionId, action.id);
    });
    row.appendChild(button);
  }

  return row;
}

function createHistorySpacer(heightPx: number): HTMLElement {
  const spacer = document.createElement('div');
  spacer.className = 'agent-history-spacer';
  spacer.style.height = `${Math.max(0, Math.round(heightPx))}px`;
  return spacer;
}

function collapseSingleParagraphMarkdownBody(container: HTMLElement): void {
  if (container.childElementCount !== 1) {
    return;
  }

  const first = container.firstElementChild;
  if (!first || first.tagName !== 'P' || first.attributes.length > 0) {
    return;
  }

  container.innerHTML = first.innerHTML;
}

function getCachedAssistantMarkdownHtml(sessionId: string, entry: LensHistoryEntry): string {
  const state = viewStates.get(sessionId);
  if (!state) {
    return renderMarkdownFragment(entry.body);
  }

  const existing = state.assistantMarkdownCache.get(entry.id);
  if (existing && existing.body === entry.body) {
    return existing.html;
  }

  const html = renderMarkdownFragment(entry.body);
  state.assistantMarkdownCache.set(entry.id, {
    body: entry.body,
    html,
  });
  return html;
}

function pruneAssistantMarkdownCache(
  state: SessionLensViewState,
  entries: readonly LensHistoryEntry[],
): void {
  if (state.assistantMarkdownCache.size === 0) {
    return;
  }

  const activeAssistantIds = new Set(
    entries.filter((entry) => entry.kind === 'assistant').map((entry) => entry.id),
  );

  for (const cacheKey of state.assistantMarkdownCache.keys()) {
    if (!activeAssistantIds.has(cacheKey)) {
      state.assistantMarkdownCache.delete(cacheKey);
    }
  }
}

function shouldRenderHistoryBody(entry: LensHistoryEntry): boolean {
  if (!entry.body.trim()) {
    return false;
  }

  if (entry.kind === 'assistant' && isAssistantPlaceholderEntry(entry)) {
    return false;
  }

  if (
    entry.kind === 'tool' &&
    !entry.body.includes('\n') &&
    normalizeComparableHistoryText(entry.body) ===
      normalizeComparableHistoryText(normalizeHistoryTitle(entry))
  ) {
    return false;
  }

  return true;
}

function resolveArtifactCluster(
  entries: readonly LensHistoryEntry[],
  index: number,
): ArtifactClusterInfo | null {
  const entry = entries[index];
  if (!entry || !isArtifactEntry(entry.kind)) {
    return null;
  }

  let start = index;
  while (start > 0 && isArtifactEntry(entries[start - 1]?.kind)) {
    start -= 1;
  }

  let end = index;
  while (end + 1 < entries.length && isArtifactEntry(entries[end + 1]?.kind)) {
    end += 1;
  }

  const count = end - start + 1;
  const position =
    count === 1 ? 'single' : index === start ? 'start' : index === end ? 'end' : 'middle';
  const clusterEntries = entries.slice(start, end + 1);
  const onlyTools = clusterEntries.every((candidate) => candidate.kind === 'tool');
  const label =
    position === 'start' && !onlyTools ? lensText('lens.cluster.workLog', 'Work log') : null;

  return {
    position,
    label,
    count,
    onlyTools,
  };
}

function isArtifactEntry(kind: HistoryKind | undefined): boolean {
  return kind === 'tool' || kind === 'reasoning' || kind === 'plan' || kind === 'diff';
}

function isAssistantPlaceholderEntry(entry: LensHistoryEntry): boolean {
  if (entry.kind !== 'assistant') {
    return false;
  }

  const normalized = entry.body.trim().toLowerCase();
  return (
    normalized === 'starting…' ||
    normalized === 'starting...' ||
    normalized === 'thinking…' ||
    normalized === 'thinking...'
  );
}

function normalizeHistoryTitle(entry: LensHistoryEntry): string {
  const title = entry.title.trim();
  if (!title) {
    return '';
  }

  if (isCommandExecutionHistoryEntry(entry)) {
    return '';
  }

  if ((entry.kind === 'user' || entry.kind === 'assistant') && title === entry.label) {
    return '';
  }

  return title;
}

async function handleHistoryAction(
  sessionId: string,
  _actionId: LensHistoryActionId,
): Promise<void> {
  await retryLensActivation(sessionId);
}

function createHistoryAttachmentBlock(
  sessionId: string,
  attachments: readonly LensAttachmentReference[] | undefined,
): HTMLElement | null {
  if (!attachments || attachments.length === 0) {
    return null;
  }

  const container = document.createElement('div');
  container.className = 'agent-history-attachments';

  for (const attachment of attachments) {
    if (isImageAttachment(attachment)) {
      const link = document.createElement('a');
      link.className = 'agent-history-attachment agent-history-attachment-image';
      link.href = buildLensAttachmentUrl(sessionId, attachment);
      link.target = '_blank';
      link.rel = 'noreferrer';

      const image = document.createElement('img');
      image.className = 'agent-history-attachment-image-el';
      image.src = link.href;
      image.loading = 'lazy';
      image.alt = resolveAttachmentLabel(attachment);
      link.appendChild(image);

      const caption = document.createElement('span');
      caption.className = 'agent-history-attachment-caption';
      caption.textContent = resolveAttachmentLabel(attachment);
      link.appendChild(caption);

      container.appendChild(link);
      continue;
    }

    const link = document.createElement('a');
    link.className = 'agent-history-attachment agent-history-attachment-file';
    link.href = buildLensAttachmentUrl(sessionId, attachment);
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = resolveAttachmentLabel(attachment);
    container.appendChild(link);
  }

  return container;
}

/**
 * Keeps timestamps and status concise so the history reads like a chat
 * surface instead of an event log, while still preserving debugging context.
 */
export function formatHistoryMeta(kind: HistoryKind, statusLabel: string, value: string): string {
  void kind;
  void statusLabel;
  return formatAbsoluteTime(value);
}

/**
 * Drops low-signal status copy once the visual hierarchy already explains the
 * role of a row, which is important for the quieter t3-style conversation UX.
 */
export function shouldHideStatusInMeta(kind: HistoryKind, statusLabel: string): boolean {
  void kind;
  void statusLabel;
  return true;
}

function createRequestActionBlock(
  sessionId: string,
  request: LensPulseRequestSummary,
  busy: boolean,
  state: SessionLensViewState,
): HTMLElement {
  const actions = document.createElement('div');
  const isUserInputRequest = request.kind === 'tool_user_input' && request.questions.length > 0;
  actions.className = `agent-request-actions agent-request-actions-composer ${isUserInputRequest ? 'agent-request-actions-user-input' : 'agent-request-actions-approval'}`;

  const panel = document.createElement('section');
  panel.className = `agent-request-panel ${isUserInputRequest ? 'agent-request-panel-user-input' : 'agent-request-panel-approval'}`;
  const activeQuestionIndex = resolveActiveRequestQuestionIndex(state, request);
  panel.appendChild(createRequestPanelHeader(request, activeQuestionIndex));

  if (isUserInputRequest) {
    const draftAnswers = ensureRequestDraftAnswers(state, request);
    const activeQuestion = request.questions[activeQuestionIndex];
    if (!activeQuestion) {
      actions.appendChild(panel);
      return actions;
    }

    const form = document.createElement('form');
    form.className = 'agent-request-form';

    form.appendChild(
      createQuestionField(
        sessionId,
        request,
        activeQuestion,
        activeQuestionIndex,
        request.questions.length,
        draftAnswers,
      ),
    );

    const controls = document.createElement('div');
    controls.className = 'agent-request-button-row';

    if (activeQuestionIndex > 0) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'agent-view-btn';
      back.disabled = busy;
      back.textContent = lensText('lens.request.back', 'Back');
      back.addEventListener('click', () => {
        setActiveRequestQuestionIndex(sessionId, request.requestId, activeQuestionIndex - 1);
      });
      controls.appendChild(back);
    }

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'agent-view-btn agent-view-btn-primary';
    submit.disabled = busy || !hasDraftAnswerForQuestion(draftAnswers, activeQuestion);
    submit.textContent =
      activeQuestionIndex < request.questions.length - 1
        ? lensText('lens.request.continue', 'Continue')
        : busy
          ? lensText('lens.request.sending', 'Sending…')
          : lensText('lens.request.sendAnswer', 'Send answer');
    controls.appendChild(submit);
    form.appendChild(controls);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (activeQuestionIndex < request.questions.length - 1) {
        setActiveRequestQuestionIndex(sessionId, request.requestId, activeQuestionIndex + 1);
        return;
      }

      const answers = collectQuestionAnswers(state, request);
      void handleResolveUserInput(sessionId, request.requestId, answers);
    });

    panel.appendChild(form);
    actions.appendChild(panel);
    return actions;
  }

  const buttonRow = document.createElement('div');
  buttonRow.className = 'agent-request-button-row';

  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'agent-view-btn agent-view-btn-primary';
  approve.disabled = busy;
  approve.textContent = busy
    ? lensText('lens.request.working', 'Working…')
    : lensText('lens.request.approveOnce', 'Approve once');
  approve.addEventListener('click', () => {
    void handleApproveRequest(sessionId, request.requestId);
  });

  const decline = document.createElement('button');
  decline.type = 'button';
  decline.className = 'agent-view-btn';
  decline.disabled = busy;
  decline.textContent = lensText('lens.request.decline', 'Decline');
  decline.addEventListener('click', () => {
    void handleDeclineRequest(sessionId, request.requestId);
  });

  buttonRow.append(approve, decline);
  panel.appendChild(buttonRow);
  actions.appendChild(panel);
  return actions;
}

function createRequestPanelHeader(
  request: LensPulseRequestSummary,
  _activeQuestionIndex = 0,
): HTMLElement {
  const header = document.createElement('div');
  header.className = 'agent-request-panel-header';

  const topRow = document.createElement('div');
  topRow.className = 'agent-request-panel-topline';

  const eyebrow = document.createElement('span');
  eyebrow.className = 'agent-request-eyebrow';
  eyebrow.textContent =
    request.kind === 'tool_user_input'
      ? lensText('lens.request.pendingUserInput', 'Pending user input')
      : lensText('lens.request.pendingApproval', 'Pending approval');
  topRow.appendChild(eyebrow);

  const summary = document.createElement('span');
  summary.className = 'agent-request-summary';
  summary.textContent = summarizeRequestInterruption(request);
  topRow.appendChild(summary);

  header.appendChild(topRow);

  if (request.detail?.trim()) {
    const detail = document.createElement('p');
    detail.className = 'agent-request-detail';
    detail.textContent = request.detail;
    header.appendChild(detail);
  }

  return header;
}

function summarizeRequestInterruption(request: LensPulseRequestSummary): string {
  if (request.kind === 'tool_user_input') {
    const activeQuestion = request.questions[0];
    if (request.questions.length === 1 && activeQuestion?.options.length) {
      return activeQuestion.multiSelect
        ? lensFormat(
            'lens.request.selectManyToContinue',
            'Select one or more of {count} options to continue.',
            { count: activeQuestion.options.length },
          )
        : lensFormat(
            'lens.request.selectOneToContinue',
            'Select 1 of {count} options to continue.',
            { count: activeQuestion.options.length },
          );
    }

    return request.questions.length === 1
      ? lensText('lens.request.needsOneAnswer', 'The agent needs one answer to continue.')
      : lensFormat(
          'lens.request.needsManyAnswers',
          'The agent needs {count} answers to continue.',
          { count: request.questions.length },
        );
  }

  const label = request.kindLabel.trim() || lensText('lens.request.approvalLabel', 'Approval');
  return lensFormat(
    'lens.request.requiredBeforeContinue',
    '{label} required before the turn can continue.',
    { label },
  );
}

function createQuestionField(
  sessionId: string,
  request: LensPulseRequestSummary,
  question: LensPulseRequestSummary['questions'][number],
  index: number,
  totalQuestions: number,
  draftAnswers: Record<string, string[]>,
): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.className = 'agent-request-field';

  const header = document.createElement('div');
  header.className = 'agent-request-field-header';

  if (question.header && question.header.trim()) {
    const fieldHeader = document.createElement('span');
    fieldHeader.className = 'agent-request-field-label';
    fieldHeader.textContent = question.header;
    header.appendChild(fieldHeader);
  }

  if (header.childElementCount > 0) {
    wrapper.appendChild(header);
  }

  const title = document.createElement('p');
  title.className = 'agent-request-question';
  title.textContent = question.question;
  wrapper.appendChild(title);

  const draftValue = draftAnswers[question.id] ?? [];
  if (question.options.length > 0 && question.multiSelect) {
    const options = createQuestionChoiceList(
      sessionId,
      request,
      question,
      'checkbox',
      draftValue,
      false,
    );
    wrapper.appendChild(options);
    return wrapper;
  }

  if (question.options.length > 0) {
    const options = createQuestionChoiceList(
      sessionId,
      request,
      question,
      'radio',
      draftValue,
      index < totalQuestions - 1,
    );
    wrapper.appendChild(options);
    return wrapper;
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.name = question.id;
  input.className = 'agent-request-input';
  input.placeholder = lensText('lens.request.typeAnswer', 'Type answer');
  input.value = draftValue[0] || '';
  input.addEventListener('input', () => {
    updateRequestDraftAnswers(sessionId, request.requestId, question.id, [input.value.trim()]);
  });
  wrapper.appendChild(input);
  return wrapper;
}

function createQuestionChoiceList(
  sessionId: string,
  request: LensPulseRequestSummary,
  question: LensPulseRequestSummary['questions'][number],
  inputType: 'checkbox' | 'radio',
  selectedAnswers: readonly string[],
  autoAdvance: boolean,
): HTMLElement {
  const options = document.createElement('div');
  options.className = 'agent-request-choice-list';

  for (const [index, option] of question.options.entries()) {
    const optionLabel = document.createElement('label');
    optionLabel.className = 'agent-request-choice';

    const input = document.createElement('input');
    input.type = inputType;
    input.name = question.id;
    input.value = option.label;
    input.className = 'agent-request-choice-input';
    input.checked = selectedAnswers.includes(option.label);
    input.addEventListener('change', () => {
      if (inputType === 'radio') {
        updateRequestDraftAnswers(sessionId, request.requestId, question.id, [option.label], false);
        if (autoAdvance) {
          const currentIndex =
            viewStates.get(sessionId)?.requestQuestionIndexById[request.requestId] ?? 0;
          setActiveRequestQuestionIndex(sessionId, request.requestId, currentIndex + 1);
          return;
        }

        renderCurrentAgentView(sessionId);
        return;
      }

      const nextAnswers = Array.from(
        options.querySelectorAll<HTMLInputElement>(
          `input[name="${CSS.escape(question.id)}"]:checked`,
        ),
      ).map((candidate) => candidate.value);
      updateRequestDraftAnswers(sessionId, request.requestId, question.id, nextAnswers);
    });
    optionLabel.appendChild(input);

    if (index < 9) {
      const shortcut = document.createElement('span');
      shortcut.className = 'agent-request-choice-shortcut';
      shortcut.textContent = String(index + 1);
      optionLabel.appendChild(shortcut);
    }

    const copy = document.createElement('span');
    copy.className = 'agent-request-choice-copy';

    const title = document.createElement('span');
    title.className = 'agent-request-choice-title';
    title.textContent = option.label;
    copy.appendChild(title);

    if (option.description && option.description !== option.label) {
      const description = document.createElement('span');
      description.className = 'agent-request-choice-description';
      description.textContent = option.description;
      copy.appendChild(description);
    }

    optionLabel.appendChild(copy);
    options.appendChild(optionLabel);
  }

  return options;
}

function collectQuestionAnswers(
  state: SessionLensViewState,
  request: LensPulseRequestSummary,
): Array<{ questionId: string; answers: string[] }> {
  const draftAnswers = ensureRequestDraftAnswers(state, request);
  return request.questions.map((question) => ({
    questionId: question.id,
    answers: (draftAnswers[question.id] ?? []).filter(Boolean),
  }));
}

function resolveActiveRequestQuestionIndex(
  state: SessionLensViewState,
  request: LensPulseRequestSummary,
): number {
  const maxIndex = Math.max(0, request.questions.length - 1);
  const currentIndex = state.requestQuestionIndexById[request.requestId] ?? 0;
  return Math.max(0, Math.min(currentIndex, maxIndex));
}

function setActiveRequestQuestionIndex(
  sessionId: string,
  requestId: string,
  nextIndex: number,
): void {
  const state = viewStates.get(sessionId);
  if (!state) {
    return;
  }

  state.requestQuestionIndexById[requestId] = Math.max(0, nextIndex);
  renderCurrentAgentView(sessionId);
}

function updateRequestDraftAnswers(
  sessionId: string,
  requestId: string,
  questionId: string,
  answers: string[],
  rerender = true,
): void {
  const state = viewStates.get(sessionId);
  if (!state) {
    return;
  }

  const requestDrafts = state.requestDraftAnswersById[requestId] ?? {};
  requestDrafts[questionId] = answers.filter((answer) => answer.trim().length > 0);
  state.requestDraftAnswersById[requestId] = requestDrafts;
  if (rerender) {
    renderCurrentAgentView(sessionId);
  }
}

function hasDraftAnswerForQuestion(
  draftAnswers: Record<string, string[]>,
  question: LensPulseRequestSummary['questions'][number],
): boolean {
  return (draftAnswers[question.id] ?? []).some((answer) => answer.trim().length > 0);
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
 * Uses a fast height heuristic for history virtualization so long agent
 * runs stay smooth without paying full layout cost on every render.
 */
export function estimateHistoryEntryHeight(entry: LensHistoryEntry, viewportWidth = 960): number {
  if (entry.busyIndicator) {
    return 52;
  }

  const effectiveWidth = Math.max(220, Math.min(viewportWidth, 960));
  const horizontalChrome =
    entry.kind === 'user'
      ? 72
      : entry.kind === 'tool' ||
          entry.kind === 'reasoning' ||
          entry.kind === 'plan' ||
          entry.kind === 'diff' ||
          entry.kind === 'request' ||
          entry.kind === 'system' ||
          entry.kind === 'notice'
        ? 56
        : 28;
  const contentWidth = Math.max(140, effectiveWidth - horizontalChrome);
  const avgCharWidthPx =
    entry.kind === 'tool' ||
    entry.kind === 'reasoning' ||
    entry.kind === 'plan' ||
    entry.kind === 'diff'
      ? 7.4
      : 8.1;
  const charsPerLine = Math.max(18, Math.floor(contentWidth / avgCharWidthPx));
  const textLines =
    entry.kind === 'diff'
      ? Math.max(1, buildRenderedDiffLines(entry.body).length)
      : Math.max(
          1,
          entry.body
            .split('\n')
            .reduce(
              (sum, line) => sum + Math.max(1, Math.ceil(Math.max(1, line.length) / charsPerLine)),
              0,
            ),
        );
  const presentation = resolveHistoryBodyPresentation(entry);
  const bodyHeight =
    presentation.mode === 'command'
      ? 24 + Math.min(8, entry.commandOutputTail?.length ?? 0) * 16
      : presentation.collapsedByDefault
        ? 40
        : Math.min(420, 18 * textLines);

  switch (entry.kind) {
    case 'tool':
    case 'reasoning':
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

function cloneHistoryAttachments(
  attachments: readonly LensAttachmentReference[] | undefined,
): LensAttachmentReference[] {
  return attachments?.map((attachment) => ({ ...attachment })) ?? [];
}

export function resolveHistoryBodyPresentation(entry: LensHistoryEntry): HistoryBodyPresentation {
  if (entry.kind === 'assistant') {
    return {
      mode: entry.live ? 'streaming' : 'markdown',
      collapsedByDefault: false,
      lineCount: countHistoryBodyLines(entry.body),
      preview: '',
    };
  }

  if (isCommandExecutionHistoryEntry(entry)) {
    return {
      mode: 'command',
      collapsedByDefault: false,
      lineCount: 1 + (entry.commandOutputTail?.length ?? 0),
      preview: '',
    };
  }

  const mode =
    entry.kind === 'diff' ? 'diff' : isMachineHistoryKind(entry.kind) ? 'monospace' : 'plain';
  const lineCount = countHistoryBodyLines(entry.body);
  const collapsedByDefault =
    mode === 'monospace' &&
    !entry.live &&
    !entry.pending &&
    (lineCount >= COLLAPSIBLE_HISTORY_BODY_MIN_LINES ||
      entry.body.length >= COLLAPSIBLE_HISTORY_BODY_MIN_CHARS);

  return {
    mode,
    collapsedByDefault,
    lineCount,
    preview: collapsedByDefault ? buildHistoryBodyPreview(entry.body) : '',
  };
}

function isMachineHistoryKind(kind: HistoryKind): boolean {
  return kind === 'tool' || kind === 'reasoning' || kind === 'plan' || kind === 'diff';
}

function isCommandExecutionHistoryEntry(entry: LensHistoryEntry): boolean {
  const normalized = normalizeHistoryItemType(entry.sourceItemType);
  return (
    entry.kind === 'tool' &&
    (normalized === 'commandexecution' ||
      normalized === 'command' ||
      normalized === 'commandcall' ||
      normalized === 'commandrun')
  );
}

function isCommandOutputHistoryEntry(entry: LensHistoryEntry): boolean {
  return (
    entry.kind === 'tool' &&
    normalizeComparableHistoryText(entry.title) === normalizeComparableHistoryText('Command output')
  );
}

function normalizeHistoryItemType(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function countHistoryBodyLines(body: string): number {
  return body.trim() ? normalizeHistoryBodyLines(body).length : 0;
}

function normalizeHistoryBodyLines(body: string): string[] {
  return body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function buildHistoryBodyPreview(body: string): string {
  const firstContentLine =
    body
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line) ?? '';
  const singleLine = firstContentLine.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= COLLAPSIBLE_HISTORY_BODY_PREVIEW_CHARS) {
    return singleLine;
  }

  return `${singleLine.slice(0, COLLAPSIBLE_HISTORY_BODY_PREVIEW_CHARS - 1)}…`;
}

function extractCommandOutputTail(body: string): string[] {
  const lines = normalizeHistoryBodyLines(body)
    .map((line) => line.replace(/\s+$/g, ''))
    .filter(
      (line, index, array) =>
        line.length > 0 || array.slice(index + 1).some((next) => next.length > 0),
    );
  return lines.slice(Math.max(0, lines.length - 12));
}

function parseCommandOutputBody(
  body: string,
): { commandText: string; commandOutputTail: string[] } | null {
  const lines = normalizeHistoryBodyLines(body).map((line) => line.replace(/\s+$/g, ''));
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentIndex < 0) {
    return null;
  }

  const commandText = lines[firstContentIndex]?.trim() ?? '';
  if (!commandText) {
    return null;
  }

  let outputStartIndex = firstContentIndex + 1;
  while (outputStartIndex < lines.length && lines[outputStartIndex]?.trim().length === 0) {
    outputStartIndex += 1;
  }

  const outputBody = lines.slice(outputStartIndex).join('\n');
  return {
    commandText,
    commandOutputTail: extractCommandOutputTail(outputBody),
  };
}

export function tokenizeCommandText(commandText: string): CommandToken[] {
  const source = commandText || '';
  const tokens: CommandToken[] = [];
  let index = 0;
  let firstWordSeen = false;

  while (index < source.length) {
    const current = source[index];
    if (!current) {
      break;
    }

    if (/\s/.test(current)) {
      let end = index + 1;
      while (end < source.length && /\s/.test(source[end] || '')) {
        end += 1;
      }
      tokens.push({ text: source.slice(index, end), kind: 'whitespace' });
      index = end;
      continue;
    }

    if (current === '"' || current === "'") {
      const quote = current;
      let end = index + 1;
      while (end < source.length) {
        const value = source[end];
        if (value === '\\') {
          end += 2;
          continue;
        }

        end += 1;
        if (value === quote) {
          break;
        }
      }
      tokens.push({ text: source.slice(index, Math.min(end, source.length)), kind: 'string' });
      index = Math.min(end, source.length);
      continue;
    }

    const operatorMatch = source.slice(index).match(/^(?:\|\||&&|>>|<<|[><=|&])/);
    if (operatorMatch?.[0]) {
      tokens.push({ text: operatorMatch[0], kind: 'operator' });
      index += operatorMatch[0].length;
      continue;
    }

    let end = index + 1;
    while (end < source.length) {
      const value = source[end];
      if (!value || /\s/.test(value) || value === '"' || value === "'") {
        break;
      }

      const nextOperator = source.slice(end).match(/^(?:\|\||&&|>>|<<|[><=|&])/);
      if (nextOperator?.[0]) {
        break;
      }

      end += 1;
    }

    const text = source.slice(index, end);
    const kind: CommandToken['kind'] = !firstWordSeen
      ? 'command'
      : text.startsWith('-')
        ? 'parameter'
        : 'text';
    tokens.push({ text, kind });
    if (!firstWordSeen && text.trim().length > 0) {
      firstWordSeen = true;
    }
    index = end;
  }

  return tokens;
}

export function formatLensTurnDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) {
    return '0s';
  }

  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (totalMinutes > 0) {
    return `${totalMinutes}m ${seconds}s`;
  }

  return `${seconds}s`;
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

function normalizeComparableHistoryText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
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

function formatTokenCount(value: number): string {
  if (value >= 1000) {
    const compact = (value / 1000).toFixed(value >= 100000 ? 0 : 1);
    return `${compact.replace(/\.0$/, '')}k`;
  }

  return String(value);
}

function formatTokenWindowCompact(stats: LensRuntimeStatsSummary): string {
  if (stats.windowUsedTokens === null || stats.windowTokenLimit === null) {
    return '-- of --';
  }

  return `${formatTokenWindowPercent(stats.windowUsedTokens, stats.windowTokenLimit)} of ${formatTokenCount(stats.windowTokenLimit)}`;
}

function formatTokenWindowDetail(stats: LensRuntimeStatsSummary): string {
  if (stats.windowUsedTokens === null || stats.windowTokenLimit === null) {
    return 'Context -- of --';
  }

  return `Context ${formatTokenWindowPercent(stats.windowUsedTokens, stats.windowTokenLimit)} of ${formatTokenCount(stats.windowTokenLimit)} (${formatTokenCount(stats.windowUsedTokens)} used)`;
}

function formatTokenWindowPercent(usedTokens: number, windowTokenLimit: number): string {
  if (windowTokenLimit <= 0) {
    return '--';
  }

  const percent = (usedTokens / windowTokenLimit) * 100;
  if (!Number.isFinite(percent)) {
    return '--';
  }

  if (percent >= 10) {
    return `${Math.round(percent)}%`;
  }

  return `${percent.toFixed(1).replace(/\.0$/, '')}%`;
}

function formatPercent(value: number | null): string {
  return value === null ? '--' : `${Math.round(value)}%`;
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
      title: lensText('lens.error.requestTitle', 'Lens request failed'),
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

function setActivationState(
  state: SessionLensViewState,
  activationState: SessionLensViewState['activationState'],
  activationDetail: string,
  summary: string,
  detail: string,
  tone: HistoryTone = 'info',
): void {
  state.activationState = activationState;
  state.activationDetail = activationDetail;
  appendActivationTrace(state, tone, activationState, summary, detail);
}

function appendActivationTrace(
  state: SessionLensViewState,
  tone: HistoryTone,
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

/**
 * Maps low-level Lens attach failures onto user-actionable guidance so the UI
 * can explain when Terminal still owns the live lane and how to recover.
 */
export function classifyLensActivationIssue(
  error: unknown,
  hasReadonlyHistory: boolean,
): LensActivationIssue {
  const description = describeError(error);
  const detail =
    error instanceof LensHttpError && error.detail.trim() ? error.detail.trim() : description;
  const normalizedDetail = detail.toLowerCase();
  const actions: LensHistoryAction[] = [
    {
      id: 'retry-lens',
      label: lensText('lens.action.retry', 'Retry Lens'),
      style: 'primary',
      busyLabel: lensText('lens.action.retryBusy', 'Retrying...'),
    },
  ];

  if (
    normalizedDetail.includes('finish or interrupt the terminal codex turn before opening lens')
  ) {
    return {
      kind: 'busy-terminal-turn',
      tone: 'warning',
      meta: hasReadonlyHistory
        ? lensText('lens.issue.readonlyHistory', 'Read-only history')
        : lensText('lens.issue.terminalBusy', 'Terminal busy'),
      title: lensText('lens.issue.busyTerminalTurn.title', 'Terminal owns the live Codex turn'),
      body: hasReadonlyHistory
        ? lensText(
            'lens.issue.busyTerminalTurn.bodyReadonly',
            'Lens is showing the last stable history while the terminal Codex turn is still running. Finish or interrupt that turn in Terminal, then retry live Lens attach.',
          )
        : lensText(
            'lens.issue.busyTerminalTurn.body',
            'Lens cannot take over while Terminal still owns the active Codex turn. Finish or interrupt that turn in Terminal, then retry.',
          ),
      actions,
    };
  }

  if (normalizedDetail.includes('could not determine the codex resume id for this session')) {
    return {
      kind: 'missing-resume-id',
      tone: 'warning',
      meta: hasReadonlyHistory
        ? lensText('lens.issue.readonlyHistory', 'Read-only history')
        : lensText('lens.issue.liveAttachUnavailable', 'Live attach unavailable'),
      title: lensText('lens.issue.missingResumeId.title', 'No resumable Codex thread is known yet'),
      body: hasReadonlyHistory
        ? lensText(
            'lens.issue.missingResumeId.bodyReadonly',
            'Lens can still show canonical history, but MidTerm does not yet know a resumable Codex thread id for live handoff in this session. Keep using Terminal for the live lane, or retry after the thread identity becomes known.',
          )
        : lensText(
            'lens.issue.missingResumeId.body',
            'MidTerm cannot determine a resumable Codex thread id for this session yet, so live Lens attach is unavailable. Use Terminal for the live lane, or retry later.',
          ),
      actions,
    };
  }

  if (normalizedDetail.includes('terminal shell did not recover after stopping codex')) {
    return {
      kind: 'shell-recovery-failed',
      tone: 'warning',
      meta: lensText('lens.issue.terminalRecoveryFailed', 'Terminal recovery failed'),
      title: lensText(
        'lens.issue.shellRecoveryFailed.title',
        'Terminal did not recover cleanly after handoff',
      ),
      body: lensText(
        'lens.issue.shellRecoveryFailed.body',
        'MidTerm stopped the foreground Codex process but the session did not settle back into a clean live lane. Retry Lens once the lane is stable again.',
      ),
      actions,
    };
  }

  if (normalizedDetail.includes('lens native runtime is not available for this session')) {
    return {
      kind: 'native-runtime-unavailable',
      tone: 'warning',
      meta: lensText('lens.issue.nativeRuntimeUnavailable', 'Native runtime unavailable'),
      title: lensText(
        'lens.issue.nativeRuntimeUnavailable.title',
        'This session cannot start a live Lens runtime yet',
      ),
      body: lensText(
        'lens.issue.nativeRuntimeUnavailable.body',
        'MidTerm could not start the native Lens runtime for this session. Retry after the session becomes native-runtime-capable.',
      ),
      actions,
    };
  }

  if (hasReadonlyHistory) {
    return {
      kind: 'readonly-history',
      tone: 'warning',
      meta: lensText('lens.issue.readonlyHistory', 'Read-only history'),
      title: lensText(
        'lens.issue.readonlyHistory.title',
        'Live Lens attach is unavailable right now',
      ),
      body: lensFormat(
        'lens.issue.readonlyHistory.body',
        '{detail} Lens is staying open on canonical history, so you can still inspect the last stable history while Terminal remains the live fallback.',
        { detail },
      ),
      actions,
    };
  }

  return {
    kind: 'startup-failed',
    tone: 'attention',
    meta: lensText('lens.issue.attachFailed', 'Lens attach failed'),
    title: lensText('lens.issue.startupFailed.title', 'Lens could not open'),
    body: detail,
    actions: [
      {
        id: 'retry-lens',
        label: lensText('lens.action.retry', 'Retry Lens'),
        style: 'primary',
        busyLabel: lensText('lens.action.retryBusy', 'Retrying...'),
      },
    ],
  };
}

function shouldShowLensDevErrorDialog(issue: LensActivationIssue | null): boolean {
  return issue?.kind === 'startup-failed';
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message) {
      return message;
    }

    const firstStackLine = error.stack?.split('\n', 1)[0]?.trim();
    return firstStackLine || error.name;
  }

  return typeof error === 'string' ? error : JSON.stringify(error, null, 2);
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

function ensureLensActivationIsCurrent(state: SessionLensViewState, activationRunId: number): void {
  if (state.debugScenarioActive || state.activationRunId !== activationRunId) {
    throw new Error(STALE_LENS_ACTIVATION);
  }
}

function isStaleLensActivationError(error: unknown): boolean {
  return error instanceof Error && error.message === STALE_LENS_ACTIVATION;
}

function toneFromState(state: string | null | undefined): HistoryTone {
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

function historyKindFromItem(itemType: string): HistoryKind {
  const normalized = itemType.toLowerCase();
  if (normalized.includes('assistant')) {
    return 'assistant';
  }
  if (normalized.includes('user') || normalized.includes('input')) {
    return 'user';
  }
  return 'tool';
}

function normalizeSnapshotHistoryKind(kind: string | null | undefined): HistoryKind {
  const normalized = (kind || '').toLowerCase();
  switch (normalized) {
    case 'user':
    case 'assistant':
    case 'reasoning':
    case 'tool':
    case 'request':
    case 'plan':
    case 'diff':
    case 'system':
    case 'notice':
      return normalized as HistoryKind;
    default:
      return 'system';
  }
}

function isImageAttachment(attachment: LensAttachmentReference): boolean {
  if (attachment.kind.toLowerCase() === 'image') {
    return true;
  }

  if ((attachment.mimeType || '').toLowerCase().startsWith('image/')) {
    return true;
  }

  return /\.(png|jpe?g|gif|bmp|webp|svg|tiff?|heic|heif|avif)$/i.test(attachment.path);
}

function buildLensAttachmentUrl(sessionId: string, attachment: LensAttachmentReference): string {
  return (
    `/api/files/view?path=${encodeURIComponent(attachment.path)}` +
    `&sessionId=${encodeURIComponent(sessionId)}`
  );
}

function resolveAttachmentLabel(attachment: LensAttachmentReference): string {
  if (attachment.displayName?.trim()) {
    return attachment.displayName.trim();
  }

  const normalizedPath = attachment.path.replace(/\\/g, '/');
  const slashIndex = normalizedPath.lastIndexOf('/');
  return slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath;
}

function normalizeLensProvider(provider: string | null | undefined): string {
  return (provider || '').trim().toLowerCase();
}

export function resolveLensLayoutMode(provider: string | null | undefined): LensLayoutMode {
  return normalizeLensProvider(provider) === 'codex' ? 'full-width-left' : 'default';
}

function historyLabel(kind: HistoryKind): string {
  switch (kind) {
    case 'user':
      return lensText('lens.label.user', 'You');
    case 'assistant':
      return lensText('lens.label.assistant', 'Assistant');
    case 'reasoning':
      return lensText('lens.label.reasoning', 'Reasoning');
    case 'tool':
      return lensText('lens.label.tool', 'Tool');
    case 'request':
      return lensText('lens.label.request', 'Request');
    case 'plan':
      return lensText('lens.label.plan', 'Plan');
    case 'diff':
      return lensText('lens.label.diff', 'Diff');
    case 'notice':
      return lensText('lens.label.error', 'Error');
    default:
      return lensText('lens.label.system', 'System');
  }
}

export function resolveHistoryBadgeLabel(
  kind: HistoryKind,
  provider: string | null | undefined,
): string {
  if (resolveLensLayoutMode(provider) === 'full-width-left') {
    if (kind === 'user') {
      return lensText('lens.label.userShort', 'User');
    }

    if (kind === 'assistant') {
      return lensText('lens.label.agent', 'Agent');
    }
  }

  return historyLabel(kind);
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
