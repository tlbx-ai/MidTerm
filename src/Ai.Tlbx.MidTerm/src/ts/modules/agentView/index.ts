import { createLogger } from '../logging';
import {
  ensureSessionWrapper,
  getTabPanel,
  onTabActivated,
  onTabDeactivated,
  setSessionLensAvailability,
  switchTab,
} from '../sessionTabs';
import {
  LENS_TURN_ACCEPTED_EVENT,
  LENS_TURN_FAILED_EVENT,
  LENS_TURN_SUBMITTED_EVENT,
  type LensTurnAcceptedEventDetail,
  type LensTurnFailedEventDetail,
  type LensTurnSubmittedEventDetail,
} from '../lens/input';
import { showDevErrorDialog } from '../../utils/devErrorDialog';
import { renderMarkdownFragment } from '../../utils/markdown';
import type { LensAttachmentReference } from '../../api/types';
import {
  getSessionState,
  getSessionBufferTail,
  attachSessionLens,
  detachSessionLens,
  getLensSnapshot,
  getLensEvents,
  approveLensRequest,
  declineLensRequest,
  resolveLensUserInput,
  openLensEventStream,
  type LensPulseEvent,
  type LensPulseRequestSummary,
  type LensPulseSnapshotResponse,
  type SessionStateResponse,
  LensHttpError,
} from '../../api/client';

const log = createLogger('agentView');
const viewStates = new Map<string, SessionLensViewState>();
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;
const TRANSCRIPT_OVERSCAN_PX = 800;
const TRANSCRIPT_VIRTUALIZE_AFTER = 80;
const STALE_LENS_ACTIVATION = '__midterm_stale_lens_activation__';
let lensTurnLifecycleBound = false;

interface SessionLensViewState {
  panel: HTMLDivElement;
  snapshot: LensPulseSnapshotResponse | null;
  events: LensPulseEvent[];
  debugScenarioActive: boolean;
  activationRunId: number;
  transcriptViewport: HTMLDivElement | null;
  transcriptEntries: LensTranscriptEntry[];
  disconnectStream: (() => void) | null;
  streamConnected: boolean;
  refreshScheduled: number | null;
  refreshInFlight: boolean;
  requestBusyIds: Set<string>;
  requestDraftAnswersById: Record<string, Record<string, string[]>>;
  requestQuestionIndexById: Record<string, number>;
  transcriptAutoScrollPinned: boolean;
  transcriptRenderScheduled: number | null;
  terminalFallback: SessionStateResponse | null;
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
  tone: TranscriptTone;
  meta: string;
  summary: string;
  detail: string;
}

type TranscriptKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool'
  | 'request'
  | 'plan'
  | 'diff'
  | 'system'
  | 'notice';
type TranscriptTone = 'info' | 'positive' | 'warning' | 'attention';
type LensTranscriptActionId = 'retry-lens';
export type LensDebugScenarioName = 'mixed' | 'tables' | 'long' | 'workflow';

const LENS_DEBUG_SCENARIO_NAMES: readonly LensDebugScenarioName[] = [
  'mixed',
  'tables',
  'long',
  'workflow',
];

interface LensTranscriptAction {
  id: LensTranscriptActionId;
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
  tone: TranscriptTone;
  meta: string;
  title: string;
  body: string;
  actions: LensTranscriptAction[];
}

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
  attachments?: LensAttachmentReference[];
  actions?: LensTranscriptAction[];
  live?: boolean;
  pending?: boolean;
  sourceItemId?: string | null;
  sourceTurnId?: string | null;
}

export interface TranscriptVirtualWindow {
  start: number;
  end: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
}

interface TranscriptViewportMetrics {
  scrollTop: number;
  clientHeight: number;
  clientWidth: number;
}

interface ArtifactClusterInfo {
  position: 'single' | 'start' | 'middle' | 'end';
  label: string | null;
  count: number;
  onlyTools: boolean;
}

/**
 * Wires Lens into the session-tab shell so supported agent sessions can open a
 * conversation-first surface without changing MidTerm's terminal-owned runtime
 * model underneath.
 */
export function initAgentView(): void {
  bindLensTurnLifecycle();
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
  if (state && state.refreshScheduled !== null) {
    window.clearTimeout(state.refreshScheduled);
  }
  if (state && state.transcriptRenderScheduled !== null) {
    window.cancelAnimationFrame(state.transcriptRenderScheduled);
  }

  viewStates.delete(sessionId);
}

/**
 * Exposes deterministic transcript fixtures so Lens UI work can be iterated
 * and regression-tested without depending on a live agent runtime.
 */
export function getLensDebugScenarioNames(): readonly LensDebugScenarioName[] {
  return LENS_DEBUG_SCENARIO_NAMES;
}

/**
 * Loads a representative Lens transcript into an existing session panel to
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
  bindTranscriptViewport(sessionId, state);

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
  state.terminalFallback = null;
  state.requestBusyIds.clear();
  state.transcriptAutoScrollPinned = true;
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

  state.activationRunId += 1;
  const activationRunId = state.activationRunId;

  const hasExistingTranscript = state.snapshot !== null || state.events.length > 0;
  if (hasExistingTranscript) {
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
  state.terminalFallback = null;

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
      'Lens runtime accepted the attach request.',
      'Lens runtime attached.',
      'Waiting for the first canonical Lens snapshot from MidTerm.',
    );
    renderCurrentAgentView(sessionId);

    const snapshot = await waitForInitialLensSnapshot(sessionId, state, activationRunId);
    ensureLensActivationIsCurrent(state, activationRunId);

    setActivationState(
      state,
      'loading-events',
      'Lens snapshot is ready. Loading recent transcript events.',
      'Lens snapshot ready.',
      'Loading the canonical Lens event backlog for this session.',
    );
    renderCurrentAgentView(sessionId);

    const eventFeed = await getLensEvents(sessionId);
    ensureLensActivationIsCurrent(state, activationRunId);
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
        'Canonical Lens history restored.',
        'MidTerm recovered canonical Lens history after the initial attach failed, so it is retrying the live attach automatically.',
      );
      await resumeLensFromHistory(sessionId, state, activationRunId);
      return;
    }

    state.activationError = describeError(error);
    state.activationIssue = classifyLensActivationIssue(error, false);
    state.terminalFallback = await tryLoadTerminalSnapshotFallback(sessionId);
    setActivationState(
      state,
      'failed',
      'Lens startup failed before the first stable snapshot became available.',
      'Lens startup failed.',
      state.activationError,
      'attention',
    );
    if (shouldShowLensDevErrorDialog(state.activationIssue)) {
      showDevErrorDialog({
        title: 'Lens failed to open',
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
    const afterSequence =
      state.events.length > 0 ? (state.events[state.events.length - 1]?.sequence ?? 0) : 0;
    const eventFeed = await getLensEvents(sessionId, afterSequence);
    ensureLensActivationIsCurrent(state, activationRunId);
    if (eventFeed.events.length > 0) {
      state.events = [...state.events, ...eventFeed.events].slice(-200);
    }
    await refreshLensSnapshot(sessionId);
    ensureLensActivationIsCurrent(state, activationRunId);
    openLiveLensStream(sessionId, state.snapshot?.latestSequence ?? eventFeed.latestSequence);
  } catch (error) {
    if (isStaleLensActivationError(error)) {
      return;
    }

    log.warn(() => `Failed to resume Lens for ${sessionId}: ${String(error)}`);
    state.activationError = describeError(error);
    state.activationIssue = classifyLensActivationIssue(error, true);
    state.terminalFallback = null;
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
    ensureLensActivationIsCurrent(state, activationRunId);
    const hasSnapshotHistory = hasRenderableLensHistory(snapshot);
    let events: LensPulseEvent[] = [];

    try {
      const eventFeed = await getLensEvents(sessionId);
      ensureLensActivationIsCurrent(state, activationRunId);
      events = eventFeed.events.slice(-200);
    } catch (error) {
      if (isStaleLensActivationError(error)) {
        return false;
      }
      log.warn(() => `Failed to load Lens events fallback for ${sessionId}: ${String(error)}`);
    }

    if (!hasSnapshotHistory && events.length === 0) {
      return false;
    }

    state.snapshot = snapshot;
    state.events = events;
    state.streamConnected = false;
    state.activationTrace = [];
    state.terminalFallback = null;
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
    snapshot.items.length > 0 ||
    snapshot.requests.length > 0 ||
    snapshot.notices.length > 0 ||
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
    transcriptViewport: null,
    transcriptEntries: [],
    disconnectStream: null,
    streamConnected: false,
    refreshScheduled: null,
    refreshInFlight: false,
    requestBusyIds: new Set<string>(),
    requestDraftAnswersById: {},
    requestQuestionIndexById: {},
    transcriptAutoScrollPinned: true,
    transcriptRenderScheduled: null,
    terminalFallback: null,
    activationState: 'idle',
    activationDetail: '',
    activationTrace: [],
    activationError: null,
    activationIssue: null,
    activationActionBusy: false,
    optimisticTurns: [],
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
        'Stress the Lens transcript with wide markdown tables and dense comparisons.',
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
      '| Delta | Lens | Replaying | 921 | 15540 | 54% | 105 ms | 650 ms | claude-opus | Claude | 0 | Canonical history restored from MidTerm and replayed into the transcript |',
      '',
      '| Metric | P50 | P95 | P99 | Target | Last good build | Regressed by | Notes |',
      '| --- | ---: | ---: | ---: | ---: | :--- | :--- | :--- |',
      '| First paint | 118 ms | 212 ms | 356 ms | 150 ms | v8.7.41-dev | +9 ms | Still acceptable in the local source loop |',
      '| Lens attach | 420 ms | 880 ms | 1420 ms | 600 ms | v8.7.39-dev | +140 ms | Regression only visible on native-runtime-blocked sessions |',
      '| Snapshot rebuild | 34 ms | 68 ms | 110 ms | 50 ms | v8.7.50-dev | -6 ms | Fast enough once canonical history exists |',
      '',
      '| Render mode | Benefit | Risk |',
      '| :--- | :--- | :--- |',
      '| Virtual window | Keeps long transcripts fast | Needs stable bottom pinning |',
      '| Inline tables | Preserves structure for operators | Can overflow on mobile without scroll container |',
    ].join('\n');
  } else if (scenario === 'long') {
    items = Array.from({ length: 140 }, (_value, index) => {
      const isUser = index % 2 === 0;
      const ordinal = index + 1;
      const body = isUser
        ? `Prompt ${ordinal}: summarize lane ${Math.floor(index / 2) + 1} and keep the transcript compact.`
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
            question: 'Which rollout posture fits this transcript best?',
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
      '| Transcript chrome | Stay quiet and readable | Good |',
      '| Streaming feel | Keep the answer alive while it grows | Live |',
      '| Tables | Preserve structure without blowing out the lane | Better |',
      '',
      '```ts',
      'const transcriptMode = "power-user";',
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
      session: {
        state: currentTurnState === 'running' ? 'running' : 'ready',
        stateLabel: currentTurnState === 'running' ? 'Running' : 'Ready',
        reason:
          scenario === 'long'
            ? 'Long synthetic history loaded for transcript virtualization.'
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
      items,
      requests,
      notices: [],
    },
    events: [],
  };
}

function ensureAgentViewSkeleton(_sessionId: string, panel: HTMLDivElement): void {
  if (panel.dataset.agentViewReady === 'true') {
    return;
  }

  panel.dataset.agentViewReady = 'true';
  panel.classList.add('agent-view-panel');
  panel.innerHTML = `
    <section class="agent-view">
      <div class="agent-chat-shell">
        <section class="agent-transcript-card">
          <div class="agent-transcript" data-agent-field="transcript"></div>
          <button type="button" class="agent-scroll-to-bottom" data-agent-field="scroll-to-bottom" hidden>Jump to live</button>
        </section>
        <section class="agent-composer-shell">
          <div class="agent-composer-interruption" data-agent-field="composer-interruption" hidden></div>
          <div class="agent-composer-host" data-agent-field="composer-host"></div>
        </section>
      </div>
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
    renderScrollToBottomControl(current.panel, current);

    if (current.transcriptEntries.length > TRANSCRIPT_VIRTUALIZE_AFTER) {
      scheduleTranscriptRender(sessionId);
    }
  });

  const scrollButton = state.panel.querySelector<HTMLButtonElement>(
    '[data-agent-field="scroll-to-bottom"]',
  );
  if (scrollButton && scrollButton.dataset.lensScrollBound !== 'true') {
    scrollButton.dataset.lensScrollBound = 'true';
    scrollButton.addEventListener('click', () => {
      scrollTranscriptToBottom(sessionId, 'smooth');
    });
  }
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
      current.activationIssue = null;
      current.activationError = null;
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
    renderActivationView(sessionId, state.panel, state);
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
  syncRequestInteractionState(state, snapshot.requests);
  const transcriptEntries = buildLensTranscriptEntries(snapshot, events);
  const visibleTranscriptEntries = suppressActiveComposerRequestEntries(
    transcriptEntries,
    snapshot.requests,
  );
  const optimistic = applyOptimisticLensTurns(
    snapshot,
    visibleTranscriptEntries,
    state.optimisticTurns,
  );
  state.optimisticTurns = optimistic.optimisticTurns;
  const renderedEntries = withActivationIssueNotice(
    withLiveAssistantState(
      snapshot,
      withInlineLensStatus(snapshot, optimistic.entries, streamConnected),
    ),
    state.activationIssue,
  );
  renderTranscript(panel, renderedEntries, snapshot.sessionId);
  renderComposerInterruption(panel, snapshot.sessionId, snapshot.requests, state);
}

export function suppressActiveComposerRequestEntries(
  entries: readonly LensTranscriptEntry[],
  requests: readonly LensPulseRequestSummary[],
): LensTranscriptEntry[] {
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
      attachments: cloneTranscriptAttachments(detail.request.attachments),
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
  void refreshLensSnapshot(detail.sessionId);
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

function renderActivationView(
  sessionId: string,
  panel: HTMLDivElement,
  state: SessionLensViewState,
): void {
  panel.dataset.agentTurnId = '';
  renderComposerInterruption(panel, sessionId, [], state);
  renderTranscript(
    panel,
    withActivationIssueNotice(buildActivationTranscriptEntries(state), state.activationIssue),
    sessionId,
  );
}

function renderTranscript(
  panel: HTMLDivElement,
  entries: LensTranscriptEntry[],
  sessionId: string,
): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="transcript"]');
  if (!container) {
    return;
  }

  const state = viewStates.get(sessionId);
  if (state) {
    state.transcriptViewport = container as HTMLDivElement;
    state.transcriptEntries = entries;
    renderScrollToBottomControl(panel, state);
  }

  if (entries.length === 0) {
    renderEmptyContainer(container, 'No transcript entries yet.');
    return;
  }

  const viewport = container as HTMLDivElement;
  const metrics = readTranscriptViewportMetrics(viewport);
  const virtualWindow = computeTranscriptVirtualWindow(
    entries,
    metrics.scrollTop,
    metrics.clientHeight,
    metrics.clientWidth,
  );
  const visibleEntries = entries.slice(virtualWindow.start, virtualWindow.end);
  const fragment = document.createDocumentFragment();
  if (virtualWindow.topSpacerPx > 0) {
    fragment.appendChild(createTranscriptSpacer(virtualWindow.topSpacerPx));
  }
  for (const [visibleIndex, entry] of visibleEntries.entries()) {
    const absoluteIndex = virtualWindow.start + visibleIndex;
    fragment.appendChild(
      createTranscriptEntry(entry, sessionId, resolveArtifactCluster(entries, absoluteIndex)),
    );
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

      const previousScrollTop = viewport.scrollTop;
      const focusCandidates =
        typeof viewport.getElementsByClassName === 'function'
          ? Array.from(viewport.getElementsByClassName('agent-transcript-entry'))
              .filter((node): node is HTMLElement => node instanceof HTMLElement)
              .filter((node) => node.dataset.pending === 'true' || node.dataset.live === 'true')
          : [];
      const viewportChildren =
        typeof viewport.children !== 'undefined'
          ? Array.from(viewport.children).filter(
              (node): node is HTMLElement =>
                node instanceof HTMLElement && node.classList.contains('agent-transcript-entry'),
            )
          : [];
      const focusTarget =
        focusCandidates[focusCandidates.length - 1] ??
        viewportChildren[viewportChildren.length - 1] ??
        null;

      if (focusTarget && typeof focusTarget.scrollIntoView === 'function') {
        focusTarget.scrollIntoView({
          block: 'end',
          inline: 'nearest',
        });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }

      if (
        entries.length > TRANSCRIPT_VIRTUALIZE_AFTER &&
        Math.abs(viewport.scrollTop - previousScrollTop) > 1
      ) {
        scheduleTranscriptRender(sessionId);
      }

      const current = viewStates.get(sessionId);
      if (current) {
        current.transcriptAutoScrollPinned = true;
        renderScrollToBottomControl(panel, current);
      }
    });
  }
}

function renderScrollToBottomControl(panel: HTMLDivElement, state: SessionLensViewState): void {
  const button = panel.querySelector<HTMLButtonElement>('[data-agent-field="scroll-to-bottom"]');
  if (!button) {
    return;
  }

  const shouldShow =
    !state.transcriptAutoScrollPinned &&
    state.transcriptEntries.length > 0 &&
    state.activationState !== 'failed';
  button.hidden = !shouldShow;
}

function scrollTranscriptToBottom(sessionId: string, behavior: ScrollBehavior = 'auto'): void {
  const state = viewStates.get(sessionId);
  const viewport = state?.transcriptViewport;
  if (!state || !viewport) {
    return;
  }

  state.transcriptAutoScrollPinned = true;
  viewport.scrollTo({
    top: viewport.scrollHeight,
    behavior,
  });
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

function readTranscriptViewportMetrics(container: HTMLDivElement): TranscriptViewportMetrics {
  return {
    scrollTop: container.scrollTop,
    clientHeight: container.clientHeight,
    clientWidth: container.clientWidth,
  };
}

/**
 * Normalizes the backend-owned Lens snapshot plus event stream into a stable
 * conversation transcript so the frontend can stay a thin presentation layer.
 */
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
      const itemKey = resolveTranscriptEntryKey(itemKind, lensEvent);
      const itemEntry = ensureEntry(itemKey, () => ({
        id: itemKey,
        order,
        kind: itemKind,
        tone: toneFromState(lensEvent.item?.status),
        label: transcriptLabel(itemKind),
        title:
          itemKind === 'tool'
            ? resolveToolTranscriptTitle(
                lensEvent.item?.itemType,
                lensEvent.item?.title,
                lensEvent.item?.detail,
              )
            : transcriptLabel(itemKind),
        body: resolveTranscriptItemBody(itemKind, lensEvent.item?.detail, lensEvent.item?.title),
        meta: formatTranscriptMeta(
          itemKind,
          prettify(lensEvent.item?.status || 'updated'),
          lensEvent.createdAt,
        ),
        attachments: cloneTranscriptAttachments(lensEvent.item?.attachments),
        sourceItemId: lensEvent.itemId,
        sourceTurnId: lensEvent.turnId,
      }));
      itemEntry.kind = itemKind;
      itemEntry.tone = toneFromState(lensEvent.item.status);
      itemEntry.label = transcriptLabel(itemKind);
      itemEntry.title =
        itemKind === 'tool'
          ? resolveToolTranscriptTitle(
              lensEvent.item.itemType,
              lensEvent.item.title,
              lensEvent.item.detail,
            )
          : transcriptLabel(itemKind);
      const itemBody = resolveTranscriptItemBody(
        itemKind,
        lensEvent.item.detail,
        lensEvent.item.title,
      );
      if (itemBody) {
        itemEntry.body = mergeTranscriptBody(itemKind, itemEntry.body, itemBody);
      }
      itemEntry.attachments = mergeTranscriptAttachments(
        itemEntry.attachments,
        lensEvent.item.attachments,
      );
      itemEntry.meta = formatTranscriptMeta(
        itemKind,
        prettify(lensEvent.item.status),
        lensEvent.createdAt,
      );
      itemEntry.sourceItemId = lensEvent.itemId;
      itemEntry.sourceTurnId = lensEvent.turnId;
    }

    if (lensEvent.contentDelta) {
      const streamKind = lensEvent.contentDelta.streamKind;
      const transcriptKind = transcriptKindFromStream(streamKind);
      if (!transcriptKind) {
        continue;
      }
      const key = resolveTranscriptEntryKey(transcriptKind, lensEvent, streamKind);
      const contentEntry = ensureEntry(key, () => ({
        id: key,
        order,
        kind: transcriptKind,
        tone: transcriptKind === 'assistant' ? 'info' : 'warning',
        label: transcriptStreamLabel(streamKind),
        title: transcriptStreamTitle(streamKind),
        body: '',
        meta: formatTranscriptMeta(transcriptKind, prettify(streamKind), lensEvent.createdAt),
        sourceItemId: lensEvent.itemId,
        sourceTurnId: lensEvent.turnId,
      }));
      contentEntry.body = appendStreamDelta(
        transcriptKind,
        contentEntry.body,
        lensEvent.contentDelta.delta,
      );
      contentEntry.meta = formatTranscriptMeta(
        transcriptKind,
        prettify(streamKind),
        lensEvent.createdAt,
      );
      contentEntry.sourceItemId = lensEvent.itemId;
      contentEntry.sourceTurnId = lensEvent.turnId;
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
        meta: formatTranscriptMeta('plan', 'Plan', lensEvent.createdAt),
        sourceTurnId: lensEvent.turnId,
      }));
      if (lensEvent.planDelta?.delta) {
        planEntry.body += lensEvent.planDelta.delta;
      }
      if (lensEvent.planCompleted?.planMarkdown) {
        planEntry.body = lensEvent.planCompleted.planMarkdown;
      }
      planEntry.meta = formatTranscriptMeta('plan', 'Plan', lensEvent.createdAt);
      planEntry.sourceTurnId = lensEvent.turnId;
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
        meta: formatTranscriptMeta('diff', 'Diff', lensEvent.createdAt),
        sourceTurnId: lensEvent.turnId,
      }));
      diffEntry.body = lensEvent.diffUpdated.unifiedDiff;
      diffEntry.meta = formatTranscriptMeta('diff', 'Diff', lensEvent.createdAt);
      diffEntry.sourceTurnId = lensEvent.turnId;
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
    }

    const eventEntry = buildSystemEntryFromEvent(lensEvent, order);
    if (eventEntry) {
      entries.push(eventEntry);
    }
  }

  let fallbackOrder = snapshot.latestSequence + 1;
  const sortedSnapshotItems = [...snapshot.items].sort(
    (left, right) => new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime(),
  );
  for (const item of sortedSnapshotItems) {
    const itemKind = transcriptKindFromItem(item.itemType);
    const itemKey = resolveSnapshotItemEntryKey(itemKind, item, fallbackOrder);
    const snapshotEntry = ensureEntry(itemKey, () => ({
      id: itemKey,
      order: fallbackOrder,
      kind: itemKind,
      tone: toneFromState(item.status),
      label: transcriptLabel(itemKind),
      title:
        itemKind === 'tool'
          ? resolveToolTranscriptTitle(item.itemType, item.title, item.detail)
          : transcriptLabel(itemKind),
      body: resolveTranscriptItemBody(itemKind, item.detail, item.title),
      meta: formatTranscriptMeta(itemKind, prettify(item.status), item.updatedAt),
      attachments: cloneTranscriptAttachments(item.attachments),
      sourceItemId: item.itemId,
      sourceTurnId: item.turnId,
    }));
    snapshotEntry.tone = toneFromState(item.status);
    snapshotEntry.label = transcriptLabel(itemKind);
    snapshotEntry.title =
      itemKind === 'tool'
        ? resolveToolTranscriptTitle(item.itemType, item.title, item.detail)
        : transcriptLabel(itemKind);
    snapshotEntry.body = mergeTranscriptBody(
      itemKind,
      snapshotEntry.body,
      resolveTranscriptItemBody(itemKind, item.detail, item.title),
    );
    snapshotEntry.attachments = mergeTranscriptAttachments(
      snapshotEntry.attachments,
      item.attachments,
    );
    snapshotEntry.meta = formatTranscriptMeta(itemKind, prettify(item.status), item.updatedAt);
    snapshotEntry.sourceItemId = item.itemId;
    snapshotEntry.sourceTurnId = item.turnId;
    fallbackOrder += 1;
  }

  const currentTurnAssistantKey = resolveCurrentTurnAssistantEntryKey(snapshot, entries);
  if (snapshot.streams.assistantText.trim()) {
    if (currentTurnAssistantKey) {
      const currentAssistantEntry = ensureEntry(currentTurnAssistantKey, () => ({
        id: currentTurnAssistantKey,
        order: fallbackOrder,
        kind: 'assistant',
        tone: 'info',
        label: 'Assistant',
        title: 'Assistant',
        body: snapshot.streams.assistantText,
        meta: formatTranscriptMeta('assistant', 'Snapshot', snapshot.generatedAt),
        sourceTurnId: snapshot.currentTurn.turnId,
      }));
      currentAssistantEntry.body = mergeProgressiveMessage(
        currentAssistantEntry.body,
        snapshot.streams.assistantText,
      );
      currentAssistantEntry.meta = formatTranscriptMeta(
        'assistant',
        'Snapshot',
        snapshot.generatedAt,
      );
      currentAssistantEntry.sourceTurnId = snapshot.currentTurn.turnId;
      fallbackOrder += 1;
    } else if (!entries.some((entry) => entry.kind === 'assistant' && entry.body.trim())) {
      entries.push({
        id: 'fallback-assistant',
        order: fallbackOrder,
        kind: 'assistant',
        tone: 'info',
        label: 'Assistant',
        title: 'Assistant',
        body: snapshot.streams.assistantText,
        meta: formatTranscriptMeta('assistant', 'Snapshot', snapshot.generatedAt),
        sourceTurnId: snapshot.currentTurn.turnId,
      });
      fallbackOrder += 1;
    }
  }

  if (
    !entries.some((entry) => entry.kind === 'reasoning' && entry.title === 'Reasoning') &&
    snapshot.streams.reasoningText.trim()
  ) {
    entries.push({
      id: 'fallback-reasoning',
      order: fallbackOrder,
      kind: 'reasoning',
      tone: 'info',
      label: 'Reasoning',
      title: 'Reasoning',
      body: snapshot.streams.reasoningText,
      meta: formatTranscriptMeta('reasoning', 'Snapshot', snapshot.generatedAt),
    });
    fallbackOrder += 1;
  }

  if (
    !entries.some((entry) => entry.kind === 'reasoning' && entry.title === 'Reasoning summary') &&
    snapshot.streams.reasoningSummaryText.trim()
  ) {
    entries.push({
      id: 'fallback-reasoning-summary',
      order: fallbackOrder,
      kind: 'reasoning',
      tone: 'info',
      label: 'Reasoning',
      title: 'Reasoning summary',
      body: snapshot.streams.reasoningSummaryText,
      meta: formatTranscriptMeta('reasoning', 'Snapshot', snapshot.generatedAt),
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
      meta: formatTranscriptMeta('plan', 'Snapshot', snapshot.generatedAt),
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
      meta: formatTranscriptMeta('diff', 'Snapshot', snapshot.generatedAt),
    });
    fallbackOrder += 1;
  }

  if (
    !entries.some((entry) => entry.kind === 'tool' && entry.title === 'Command output') &&
    snapshot.streams.commandOutput.trim()
  ) {
    entries.push({
      id: 'fallback-command-output',
      order: fallbackOrder,
      kind: 'tool',
      tone: 'warning',
      label: 'Tool',
      title: 'Command output',
      body: snapshot.streams.commandOutput,
      meta: formatTranscriptMeta('tool', 'Snapshot', snapshot.generatedAt),
    });
    fallbackOrder += 1;
  }

  if (
    !entries.some((entry) => entry.kind === 'tool' && entry.title === 'File change output') &&
    snapshot.streams.fileChangeOutput.trim()
  ) {
    entries.push({
      id: 'fallback-file-change-output',
      order: fallbackOrder,
      kind: 'tool',
      tone: 'warning',
      label: 'Tool',
      title: 'File change output',
      body: snapshot.streams.fileChangeOutput,
      meta: formatTranscriptMeta('tool', 'Snapshot', snapshot.generatedAt),
    });
  }

  for (const request of snapshot.requests) {
    const key = `request:${request.requestId}`;
    const entry = ensureEntry(key, () =>
      createRequestTranscriptEntry(request.requestId, request, null, fallbackOrder),
    );
    updateRequestTranscriptEntry(entry, request, null);
    entry.order = Math.max(entry.order, fallbackOrder);
    fallbackOrder += 1;
  }

  return entries
    .filter(
      (entry) =>
        entry.body.trim() ||
        (entry.attachments?.length ?? 0) > 0 ||
        entry.kind === 'request' ||
        entry.kind === 'system' ||
        entry.kind === 'notice',
    )
    .sort((left, right) => left.order - right.order);
}

/**
 * Keeps the conversation responsive while the canonical Lens snapshot catches
 * up, so submitted turns feel immediate even though authority stays server-side.
 */
export function applyOptimisticLensTurns(
  snapshot: LensPulseSnapshotResponse,
  entries: readonly LensTranscriptEntry[],
  optimisticTurns: readonly PendingLensTurn[],
): {
  entries: LensTranscriptEntry[];
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
        label: 'You',
        title: '',
        body: turn.text,
        meta: formatTranscriptMeta(
          'user',
          turn.status === 'submitted' ? 'Sending' : 'Sent',
          turn.submittedAt,
        ),
        attachments: cloneTranscriptAttachments(turn.attachments),
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
        label: 'Assistant',
        title: '',
        body: turn.status === 'submitted' ? 'Starting…' : 'Thinking…',
        meta: formatTranscriptMeta(
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
      title: '',
      body: statusBody,
      meta: streamConnected ? '' : 'Connecting',
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
  entries: LensTranscriptEntry[],
): LensTranscriptEntry[] {
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

/**
 * Surfaces attach and handoff failures inside the conversation lane so users
 * understand why Lens fell back instead of hunting through separate chrome.
 */
export function withActivationIssueNotice(
  entries: LensTranscriptEntry[],
  issue: LensActivationIssue | null,
): LensTranscriptEntry[] {
  if (!issue) {
    return entries;
  }

  return [
    {
      id: `lens-issue:${issue.kind}`,
      order: Number.MIN_SAFE_INTEGER,
      kind: issue.tone === 'attention' ? 'notice' : 'system',
      tone: issue.tone,
      label: 'MidTerm',
      title: issue.title,
      body: issue.body,
      meta: issue.meta,
      actions: issue.actions,
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
    body: formatRequestTranscriptBody(request, lensEvent) || 'Action required.',
    meta: request
      ? formatTranscriptMeta('request', prettify(request.state), request.updatedAt)
      : formatTranscriptMeta(
          'request',
          'Request',
          lensEvent?.createdAt || new Date().toISOString(),
        ),
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
  entry.body = formatRequestTranscriptBody(request, lensEvent) || entry.body;
  entry.meta = request
    ? formatTranscriptMeta('request', prettify(request.state), request.updatedAt)
    : lensEvent
      ? formatTranscriptMeta('request', prettify(lensEvent.type), lensEvent.createdAt)
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
      meta: formatTranscriptMeta(
        lensEvent.type === 'runtime.error' ? 'notice' : 'system',
        prettify(lensEvent.type),
        lensEvent.createdAt,
      ),
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
      meta: formatTranscriptMeta('notice', prettify(lensEvent.type), lensEvent.createdAt),
    };
  }

  return null;
}

/**
 * Renders Lens attach and recovery progress as transcript entries so the user
 * sees handoff progress in the same place they expect the conversation to live.
 */
export function buildActivationTranscriptEntries(
  state: SessionLensViewState,
): LensTranscriptEntry[] {
  const terminalFallbackEntry = buildTerminalFallbackEntry(state.terminalFallback);

  if (state.activationTrace.length === 0) {
    const entries: LensTranscriptEntry[] = [
      {
        id: 'activation:pending',
        order: 0,
        kind: 'system',
        tone: state.activationState === 'failed' ? 'attention' : 'warning',
        label: 'MidTerm',
        title: '',
        body: state.activationDetail || 'Waiting for Lens boot steps…',
        meta: state.activationState === 'failed' ? 'Failed' : 'Connecting',
      },
    ];

    if (terminalFallbackEntry) {
      entries.unshift(terminalFallbackEntry);
    }

    return entries;
  }

  const traceEntries = shouldCompactActivationTrace(state.activationIssue)
    ? state.activationTrace.filter((entry) => entry.tone !== 'attention').slice(-2)
    : state.activationTrace;

  const entries: LensTranscriptEntry[] = traceEntries.map((entry, index) => ({
    id: `activation:${index}`,
    order: index,
    kind: entry.tone === 'attention' ? ('notice' as const) : ('system' as const),
    tone: entry.tone,
    label: 'MidTerm',
    title: '',
    body: entry.detail,
    meta: entry.meta,
  }));

  if (terminalFallbackEntry) {
    return [terminalFallbackEntry, ...entries];
  }

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

function createTranscriptEntry(
  entry: LensTranscriptEntry,
  sessionId: string,
  artifactCluster: ArtifactClusterInfo | null = null,
): HTMLElement {
  const article = document.createElement('article');
  article.className = `agent-transcript-entry agent-transcript-${entry.kind} agent-transcript-${entry.tone}`;
  article.dataset.kind = entry.kind;
  article.dataset.tone = entry.tone;
  if (artifactCluster) {
    article.dataset.artifactPosition = artifactCluster.position;
    article.classList.add('agent-transcript-artifact');
  }
  if (entry.pending) {
    article.dataset.pending = 'true';
    article.classList.add('agent-transcript-pending');
  }
  if (entry.live) {
    article.dataset.live = 'true';
    article.classList.add('agent-transcript-live');
  }
  if (entry.kind === 'assistant' && isAssistantPlaceholderEntry(entry)) {
    article.dataset.placeholder = 'true';
    article.classList.add('agent-transcript-assistant-placeholder');
  }

  if (artifactCluster?.label) {
    article.appendChild(createArtifactClusterLabel(artifactCluster));
  }

  const header = document.createElement('div');
  header.className = 'agent-transcript-header';

  const badge = document.createElement('span');
  badge.className = `agent-transcript-badge agent-transcript-badge-${entry.kind}`;
  badge.textContent = entry.label;

  const meta = document.createElement('div');
  meta.className = 'agent-transcript-meta';
  meta.textContent = entry.meta;

  header.appendChild(badge);
  if (entry.meta.trim()) {
    header.appendChild(meta);
  }
  article.appendChild(header);

  const titleText = normalizeTranscriptTitle(entry);
  if (titleText) {
    const title = document.createElement('div');
    title.className = 'agent-transcript-title';
    title.textContent = titleText;
    article.appendChild(title);
  }

  if (shouldRenderTranscriptBody(entry)) {
    const body = document.createElement(
      entry.kind === 'diff' ||
        entry.kind === 'tool' ||
        entry.kind === 'reasoning' ||
        entry.kind === 'plan'
        ? 'pre'
        : 'div',
    );
    body.className = 'agent-transcript-body';
    if (entry.kind === 'assistant') {
      body.classList.add('agent-transcript-markdown');
      body.innerHTML = renderMarkdownFragment(entry.body);
      collapseSingleParagraphMarkdownBody(body);
      if (entry.live) {
        const caret = document.createElement('span');
        caret.className = 'agent-transcript-caret';
        caret.setAttribute('aria-hidden', 'true');
        body.appendChild(caret);
      }
    } else {
      body.textContent = entry.body;
    }
    article.appendChild(body);
  }

  const attachmentBlock = createTranscriptAttachmentBlock(sessionId, entry.attachments);
  if (attachmentBlock) {
    article.appendChild(attachmentBlock);
  }

  if (entry.actions && entry.actions.length > 0) {
    article.appendChild(createTranscriptActionBlock(sessionId, entry.actions));
  }

  return article;
}

function createArtifactClusterLabel(cluster: ArtifactClusterInfo): HTMLElement {
  const label = document.createElement('div');
  label.className = 'agent-transcript-artifact-cluster-label';
  label.textContent = `${cluster.label}${cluster.count > 1 ? ` (${cluster.count})` : ''}`;
  return label;
}

function createTranscriptActionBlock(
  sessionId: string,
  actions: readonly LensTranscriptAction[],
): HTMLElement {
  const state = viewStates.get(sessionId);
  const busy = state?.activationActionBusy === true;
  const row = document.createElement('div');
  row.className = 'agent-transcript-actions';

  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      action.style === 'primary' ? 'agent-view-btn agent-view-btn-primary' : 'agent-view-btn';
    button.disabled = busy;
    button.textContent = busy ? action.busyLabel || action.label : action.label;
    button.addEventListener('click', () => {
      void handleTranscriptAction(sessionId, action.id);
    });
    row.appendChild(button);
  }

  return row;
}

function createTranscriptSpacer(heightPx: number): HTMLElement {
  const spacer = document.createElement('div');
  spacer.className = 'agent-transcript-spacer';
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

function shouldRenderTranscriptBody(entry: LensTranscriptEntry): boolean {
  if (!entry.body.trim()) {
    return false;
  }

  if (entry.kind === 'assistant' && isAssistantPlaceholderEntry(entry)) {
    return false;
  }

  if (
    entry.kind === 'tool' &&
    !entry.body.includes('\n') &&
    normalizeComparableTranscriptText(entry.body) ===
      normalizeComparableTranscriptText(normalizeTranscriptTitle(entry))
  ) {
    return false;
  }

  return true;
}

function resolveArtifactCluster(
  entries: readonly LensTranscriptEntry[],
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
    position === 'start' && (count > 1 || !onlyTools)
      ? onlyTools
        ? 'Tool calls'
        : 'Work log'
      : null;

  return {
    position,
    label,
    count,
    onlyTools,
  };
}

function isArtifactEntry(kind: TranscriptKind | undefined): boolean {
  return kind === 'tool' || kind === 'reasoning' || kind === 'plan' || kind === 'diff';
}

function isAssistantPlaceholderEntry(entry: LensTranscriptEntry): boolean {
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

async function handleTranscriptAction(
  sessionId: string,
  _actionId: LensTranscriptActionId,
): Promise<void> {
  await retryLensActivation(sessionId);
}

function createTranscriptAttachmentBlock(
  sessionId: string,
  attachments: readonly LensAttachmentReference[] | undefined,
): HTMLElement | null {
  if (!attachments || attachments.length === 0) {
    return null;
  }

  const container = document.createElement('div');
  container.className = 'agent-transcript-attachments';

  for (const attachment of attachments) {
    if (isImageAttachment(attachment)) {
      const link = document.createElement('a');
      link.className = 'agent-transcript-attachment agent-transcript-attachment-image';
      link.href = buildLensAttachmentUrl(sessionId, attachment);
      link.target = '_blank';
      link.rel = 'noreferrer';

      const image = document.createElement('img');
      image.className = 'agent-transcript-attachment-image-el';
      image.src = link.href;
      image.loading = 'lazy';
      image.alt = resolveAttachmentLabel(attachment);
      link.appendChild(image);

      const caption = document.createElement('span');
      caption.className = 'agent-transcript-attachment-caption';
      caption.textContent = resolveAttachmentLabel(attachment);
      link.appendChild(caption);

      container.appendChild(link);
      continue;
    }

    const link = document.createElement('a');
    link.className = 'agent-transcript-attachment agent-transcript-attachment-file';
    link.href = buildLensAttachmentUrl(sessionId, attachment);
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = resolveAttachmentLabel(attachment);
    container.appendChild(link);
  }

  return container;
}

/**
 * Keeps timestamps and status concise so the transcript reads like a chat
 * surface instead of an event log, while still preserving debugging context.
 */
export function formatTranscriptMeta(
  kind: TranscriptKind,
  statusLabel: string,
  value: string,
): string {
  const timeText = formatAbsoluteTime(value);
  const normalizedStatus = statusLabel.trim();
  if (!normalizedStatus) {
    return timeText;
  }

  if (shouldHideStatusInMeta(kind, normalizedStatus)) {
    return timeText;
  }

  return `${normalizedStatus} • ${timeText}`;
}

/**
 * Drops low-signal status copy once the visual hierarchy already explains the
 * role of a row, which is important for the quieter t3-style conversation UX.
 */
export function shouldHideStatusInMeta(kind: TranscriptKind, statusLabel: string): boolean {
  const normalizedStatus = statusLabel.trim().toLowerCase();
  if (!normalizedStatus) {
    return true;
  }

  if (kind === 'user' || kind === 'assistant') {
    return (
      normalizedStatus === 'completed' ||
      normalizedStatus === 'updated' ||
      normalizedStatus === 'assistant text' ||
      normalizedStatus === 'snapshot'
    );
  }

  if (kind === 'tool' || kind === 'reasoning' || kind === 'plan' || kind === 'diff') {
    return normalizedStatus === 'completed' || normalizedStatus === 'updated';
  }

  return false;
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
      back.textContent = 'Back';
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
        ? 'Continue'
        : busy
          ? 'Sending…'
          : 'Send answer';
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
  approve.textContent = busy ? 'Working…' : 'Approve once';
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
  panel.appendChild(buttonRow);
  actions.appendChild(panel);
  return actions;
}

function createRequestPanelHeader(
  request: LensPulseRequestSummary,
  activeQuestionIndex = 0,
): HTMLElement {
  const header = document.createElement('div');
  header.className = 'agent-request-panel-header';

  const topRow = document.createElement('div');
  topRow.className = 'agent-request-panel-topline';

  const eyebrow = document.createElement('span');
  eyebrow.className = 'agent-request-eyebrow';
  eyebrow.textContent =
    request.kind === 'tool_user_input' ? 'Pending user input' : 'Pending approval';
  topRow.appendChild(eyebrow);

  const summary = document.createElement('span');
  summary.className = 'agent-request-summary';
  summary.textContent = summarizeRequestInterruption(request);
  topRow.appendChild(summary);

  if (request.kind === 'tool_user_input' && request.questions.length > 1) {
    const progress = document.createElement('span');
    progress.className = 'agent-request-progress';
    progress.textContent = `${activeQuestionIndex + 1}/${request.questions.length}`;
    topRow.appendChild(progress);
  }

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
        ? `Select one or more of ${activeQuestion.options.length} options to continue.`
        : `Select 1 of ${activeQuestion.options.length} options to continue.`;
    }

    return request.questions.length === 1
      ? 'The agent needs one answer to continue.'
      : `The agent needs ${request.questions.length} answers to continue.`;
  }

  const label = request.kindLabel.trim() || 'Approval';
  return `${label} required before the turn can continue.`;
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

  if (totalQuestions > 1) {
    const indexBadge = document.createElement('span');
    indexBadge.className = 'agent-request-field-index';
    indexBadge.textContent = `${index + 1}/${totalQuestions}`;
    header.appendChild(indexBadge);
  }

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
  input.placeholder = 'Type answer';
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

function renderEmptyContainer(container: HTMLElement, text: string): void {
  const empty = document.createElement('div');
  empty.className = 'agent-transcript-empty';
  empty.textContent = text;
  container.replaceChildren(empty);
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

/**
 * Uses a fast height heuristic for transcript virtualization so long agent
 * runs stay smooth without paying full layout cost on every render.
 */
export function estimateTranscriptEntryHeight(
  entry: LensTranscriptEntry,
  viewportWidth = 960,
): number {
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
  const wrappedLines = entry.body
    .split('\n')
    .reduce(
      (sum, line) => sum + Math.max(1, Math.ceil(Math.max(1, line.length) / charsPerLine)),
      0,
    );
  const textLines = Math.max(1, wrappedLines);
  const bodyHeight = Math.min(420, 18 * textLines);

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
 * Virtualizes long desktop transcripts while deliberately staying simpler on
 * mobile, where dense but predictable scrolling mattered more than big-history
 * optimization in the recent Lens UX pass.
 */
export function computeTranscriptVirtualWindow(
  entries: ReadonlyArray<LensTranscriptEntry>,
  scrollTop: number,
  clientHeight: number,
  clientWidth = typeof window === 'undefined' ? 960 : window.innerWidth,
): TranscriptVirtualWindow {
  if (entries.length <= TRANSCRIPT_VIRTUALIZE_AFTER || clientWidth <= 720) {
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

    const height = estimateTranscriptEntryHeight(entry, clientWidth);
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

    cumulative += estimateTranscriptEntryHeight(entry, clientWidth);
    end += 1;
  }

  const totalHeight = entries.reduce(
    (sum, entry) => sum + estimateTranscriptEntryHeight(entry, clientWidth),
    0,
  );

  return {
    start,
    end: Math.max(end, start + 1),
    topSpacerPx,
    bottomSpacerPx: Math.max(0, totalHeight - cumulative),
  };
}

function appendTranscriptChunk(existing: string, delta: string): string {
  const trimmedDelta = normalizeTranscriptText(delta).trim();
  if (!trimmedDelta) {
    return existing;
  }

  const trimmedExisting = normalizeTranscriptText(existing).trimEnd();
  if (!trimmedExisting) {
    return trimmedDelta;
  }

  if (trimmedExisting.includes(trimmedDelta)) {
    return trimmedExisting;
  }

  const separator = trimmedExisting.endsWith('\n') || trimmedDelta.startsWith('\n') ? '\n' : '\n\n';
  return `${trimmedExisting}${separator}${trimmedDelta}`;
}

function mergeTranscriptBody(kind: TranscriptKind, existing: string, incoming: string): string {
  const trimmedIncoming = normalizeTranscriptText(incoming).trim();
  if (!trimmedIncoming) {
    return existing;
  }

  if (kind === 'assistant' || kind === 'user') {
    return mergeProgressiveMessage(existing, trimmedIncoming);
  }

  return appendTranscriptChunk(existing, trimmedIncoming);
}

function mergeTranscriptAttachments(
  existing: readonly LensAttachmentReference[] | undefined,
  incoming: readonly LensAttachmentReference[] | undefined,
): LensAttachmentReference[] {
  const merged = cloneTranscriptAttachments(existing);
  if (!incoming || incoming.length === 0) {
    return merged;
  }

  const seen = new Set(merged.map(attachmentIdentity));
  for (const attachment of incoming) {
    const identity = attachmentIdentity(attachment);
    if (seen.has(identity)) {
      continue;
    }

    seen.add(identity);
    merged.push({ ...attachment });
  }

  return merged;
}

function cloneTranscriptAttachments(
  attachments: readonly LensAttachmentReference[] | undefined,
): LensAttachmentReference[] {
  return attachments?.map((attachment) => ({ ...attachment })) ?? [];
}

function attachmentIdentity(attachment: LensAttachmentReference): string {
  return [
    attachment.kind || '',
    attachment.path || '',
    attachment.mimeType || '',
    attachment.displayName || '',
  ].join('|');
}

function resolveTranscriptEntryKey(
  kind: TranscriptKind,
  lensEvent: LensPulseEvent,
  discriminator: string | null = null,
): string {
  const itemIdentity = lensEvent.itemId || lensEvent.turnId || lensEvent.sequence;
  if (kind === 'tool' || kind === 'reasoning') {
    return `${kind}:${discriminator || 'default'}:${itemIdentity}`;
  }

  if (kind === 'assistant') {
    return `${kind}:${itemIdentity}`;
  }

  if (kind === 'user') {
    return `${kind}:${lensEvent.turnId || lensEvent.itemId || lensEvent.sequence}`;
  }

  return `${kind}:${itemIdentity}`;
}

function resolveSnapshotItemEntryKey(
  kind: TranscriptKind,
  item: {
    itemId: string;
    turnId: string | null;
  },
  fallbackOrder: number,
): string {
  if (kind === 'tool') {
    return `tool:${item.itemId || item.turnId || fallbackOrder}`;
  }

  if (kind === 'assistant') {
    return `${kind}:${item.itemId || item.turnId || fallbackOrder}`;
  }

  if (kind === 'user') {
    return `${kind}:${item.turnId || item.itemId || fallbackOrder}`;
  }

  return `${kind}:${item.itemId || item.turnId || fallbackOrder}`;
}

function mergeProgressiveMessage(existing: string, incoming: string): string {
  const normalizedExisting = normalizeTranscriptText(existing);
  const normalizedIncoming = normalizeTranscriptText(incoming);
  const trimmedExisting = normalizedExisting.trim();
  if (!trimmedExisting) {
    return normalizedIncoming;
  }

  if (trimmedExisting === normalizedIncoming) {
    return trimmedExisting;
  }

  if (normalizedIncoming.includes(trimmedExisting)) {
    return normalizedIncoming;
  }

  if (trimmedExisting.includes(normalizedIncoming)) {
    return trimmedExisting;
  }

  const overlapLength = findMessageOverlap(trimmedExisting, normalizedIncoming);
  if (overlapLength > 0) {
    return `${trimmedExisting}${normalizedIncoming.slice(overlapLength)}`;
  }

  return appendTranscriptChunk(trimmedExisting, normalizedIncoming);
}

function findMessageOverlap(left: string, right: string): number {
  const maxOverlap = Math.min(left.length, right.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (left.slice(-overlap) === right.slice(0, overlap)) {
      return overlap;
    }
  }

  return 0;
}

function appendStreamDelta(kind: TranscriptKind, existing: string, delta: string): string {
  if (kind === 'assistant') {
    return `${normalizeTranscriptText(existing)}${normalizeTranscriptText(delta)}`;
  }

  return appendTranscriptChunk(existing, delta);
}

function normalizeTranscriptText(value: string | null | undefined): string {
  return (value || '').replace(/\r\n?/g, '\n');
}

function normalizeComparableTranscriptText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function resolveCurrentTurnAssistantEntryKey(
  snapshot: LensPulseSnapshotResponse,
  entries: readonly LensTranscriptEntry[],
): string | null {
  const turnId = snapshot.currentTurn.turnId;
  if (!turnId) {
    return null;
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === 'assistant' && entry.sourceTurnId === turnId) {
      return entry.id;
    }
  }

  for (let index = snapshot.items.length - 1; index >= 0; index -= 1) {
    const item = snapshot.items[index];
    if (!item) {
      continue;
    }

    if (transcriptKindFromItem(item.itemType) === 'assistant' && item.turnId === turnId) {
      return resolveSnapshotItemEntryKey('assistant', item, snapshot.latestSequence + 1);
    }
  }

  return `assistant:${turnId}`;
}

function resolveTranscriptItemBody(
  kind: TranscriptKind,
  detail: string | null | undefined,
  title: string | null | undefined,
): string {
  if (kind === 'tool') {
    return normalizeTranscriptText(detail || '').trim();
  }

  const trimmedDetail = normalizeTranscriptText(detail || '').trim();
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

function resolveToolTranscriptTitle(
  itemType: string | null | undefined,
  title: string | null | undefined,
  detail: string | null | undefined,
): string {
  const compactTitle = compactToolTitle(title || itemType || 'tool');
  if (compactTitle && !isGenericToolTitle(compactTitle)) {
    return compactTitle;
  }

  const detailSummary = summarizeToolDetail(detail);
  if (detailSummary) {
    return detailSummary;
  }

  return compactTitle || transcriptLabel('tool');
}

function isGenericToolTitle(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return new Set([
    'tool',
    'command',
    'command execution',
    'file change',
    'web search',
    'dynamic tool call',
    'mcp tool call',
  ]).has(normalized);
}

function summarizeToolDetail(detail: string | null | undefined): string {
  const firstLine = detail
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return '';
  }

  return firstLine.length > 84 ? `${firstLine.slice(0, 81)}...` : firstLine;
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
  activationRunId: number,
): Promise<LensPulseSnapshotResponse> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    ensureLensActivationIsCurrent(state, activationRunId);
    try {
      const snapshot = await getLensSnapshot(sessionId);
      ensureLensActivationIsCurrent(state, activationRunId);
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
      if (isStaleLensActivationError(error)) {
        throw error;
      }
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
  const actions: LensTranscriptAction[] = [
    { id: 'retry-lens', label: 'Retry Lens', style: 'primary', busyLabel: 'Retrying...' },
  ];

  if (
    normalizedDetail.includes('finish or interrupt the terminal codex turn before opening lens')
  ) {
    return {
      kind: 'busy-terminal-turn',
      tone: 'warning',
      meta: hasReadonlyHistory ? 'Read-only history' : 'Terminal busy',
      title: 'Terminal owns the live Codex turn',
      body: hasReadonlyHistory
        ? 'Lens is showing the last stable transcript while the terminal Codex turn is still running. Finish or interrupt that turn in Terminal, then retry live Lens attach.'
        : 'Lens cannot take over while Terminal still owns the active Codex turn. Finish or interrupt that turn in Terminal, then retry.',
      actions,
    };
  }

  if (normalizedDetail.includes('could not determine the codex resume id for this session')) {
    return {
      kind: 'missing-resume-id',
      tone: 'warning',
      meta: hasReadonlyHistory ? 'Read-only history' : 'Live attach unavailable',
      title: 'No resumable Codex thread is known yet',
      body: hasReadonlyHistory
        ? 'Lens can still show canonical history, but MidTerm does not yet know a resumable Codex thread id for live handoff in this session. Keep using Terminal for the live lane, or retry after the thread identity becomes known.'
        : 'MidTerm cannot determine a resumable Codex thread id for this session yet, so live Lens attach is unavailable. Use Terminal for the live lane, or retry later.',
      actions,
    };
  }

  if (normalizedDetail.includes('terminal shell did not recover after stopping codex')) {
    return {
      kind: 'shell-recovery-failed',
      tone: 'warning',
      meta: 'Terminal recovery failed',
      title: 'Terminal did not recover cleanly after handoff',
      body: 'MidTerm stopped the foreground Codex process but the session did not settle back into a clean live lane. Retry Lens once the lane is stable again.',
      actions,
    };
  }

  if (normalizedDetail.includes('lens native runtime is not available for this session')) {
    return {
      kind: 'native-runtime-unavailable',
      tone: 'warning',
      meta: 'Native runtime unavailable',
      title: 'This session cannot start a live Lens runtime yet',
      body: 'MidTerm could not start the native Lens runtime for this session. Retry after the session becomes native-runtime-capable.',
      actions,
    };
  }

  if (hasReadonlyHistory) {
    return {
      kind: 'readonly-history',
      tone: 'warning',
      meta: 'Read-only history',
      title: 'Live Lens attach is unavailable right now',
      body: `${detail} Lens is staying open on canonical history, so you can still inspect the last stable transcript while Terminal remains the live fallback.`,
      actions,
    };
  }

  return {
    kind: 'startup-failed',
    tone: 'attention',
    meta: 'Lens attach failed',
    title: 'Lens could not open',
    body: detail,
    actions: [
      { id: 'retry-lens', label: 'Retry Lens', style: 'primary', busyLabel: 'Retrying...' },
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

async function tryLoadTerminalSnapshotFallback(
  sessionId: string,
): Promise<SessionStateResponse | null> {
  try {
    const [response, bufferTail] = await Promise.all([
      getSessionState(sessionId, false),
      getSessionBufferTail(sessionId, 120, true),
    ]);
    if (!bufferTail.trim()) {
      return null;
    }

    response.bufferText = bufferTail;
    return response;
  } catch (error) {
    log.warn(() => `Failed to load terminal snapshot fallback for ${sessionId}: ${String(error)}`);
    return null;
  }
}

/**
 * Preserves useful context when live Lens attach fails by turning the current
 * terminal buffer into a read-only conversation artifact instead of a dead end.
 */
export function buildTerminalFallbackEntry(
  state: SessionStateResponse | null,
): LensTranscriptEntry | null {
  const body = summarizeTerminalFallbackBuffer(state?.bufferText);
  if (!body) {
    return null;
  }

  const session = state?.session;
  const sessionLabel = [session?.shellType, session?.supervisor?.profile]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(' • ');

  return {
    id: 'terminal:fallback',
    order: -1,
    kind: 'tool',
    tone: 'info',
    label: 'Terminal',
    title: resolveTerminalFallbackTitle(state),
    body,
    meta: sessionLabel ? `Read-only fallback • ${sessionLabel}` : 'Read-only fallback',
  };
}

function resolveTerminalFallbackTitle(state: SessionStateResponse | null): string {
  const session = state?.session;
  return (
    session?.foregroundDisplayName?.trim() ||
    session?.foregroundCommandLine?.trim() ||
    session?.terminalTitle?.trim() ||
    'Current terminal buffer'
  );
}

/**
 * Trims noisy terminal history into a compact fallback snapshot so Lens can
 * show enough context to recover without drowning the conversation surface.
 */
export function summarizeTerminalFallbackBuffer(value: string | null | undefined): string {
  const normalized = (value || '').replace(/\r\n/g, '\n').trimEnd();
  if (!normalized.trim()) {
    return '';
  }

  const lines = normalized.split('\n').map(compactRepeatedTerminalLine);
  const truncatedLines = lines.length > 120 ? lines.slice(-120) : lines;
  let truncated = truncatedLines.join('\n');
  if (truncated.length > 12000) {
    truncated = truncated.slice(-12000);
  }

  const omitted =
    truncatedLines.length !== lines.length || truncated.length !== normalized.length
      ? '... earlier terminal output omitted ...\n'
      : '';

  return `${omitted}${truncated}`.trimEnd();
}

function compactRepeatedTerminalLine(line: string): string {
  const trimmed = line.trimEnd();
  if (trimmed.length < 2 || trimmed.length % 2 !== 0) {
    return trimmed;
  }

  const half = trimmed.length / 2;
  const left = trimmed.slice(0, half);
  const right = trimmed.slice(half);
  return left === right ? left : trimmed;
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
    'Retrying Lens attach.',
    'MidTerm is retrying the live Lens attach for this session.',
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

function formatRequestTranscriptBody(
  request: LensPulseRequestSummary | undefined,
  lensEvent: LensPulseEvent | null,
): string {
  if (request) {
    return formatRequestSummaryBody(request);
  }

  const eventSections = [
    lensEvent?.requestOpened?.detail?.trim() || '',
    formatRequestQuestions(lensEvent?.userInputRequested?.questions),
  ].filter(Boolean);
  return eventSections.join('\n\n');
}

function formatRequestSummaryBody(request: LensPulseRequestSummary): string {
  const sections = [
    request.detail?.trim() || '',
    formatRequestQuestions(request.questions),
    formatRequestAnswers(request.answers),
  ].filter(Boolean);
  return sections.join('\n\n');
}

function formatRequestQuestions(
  questions:
    | ReadonlyArray<LensPulseRequestSummary['questions'][number]>
    | NonNullable<LensPulseEvent['userInputRequested']>['questions']
    | null
    | undefined,
): string {
  if (!questions || questions.length === 0) {
    return '';
  }

  return questions
    .map((question, index) => {
      const headingParts = [
        questions.length > 1 ? `Question ${index + 1}` : 'Question',
        question.header.trim(),
      ].filter(Boolean);
      const optionLines =
        question.options.length > 0
          ? question.options.map((option, optionIndex) => {
              const description =
                option.description && option.description !== option.label
                  ? ` - ${option.description}`
                  : '';
              return `[${optionIndex + 1}] ${option.label}${description}`;
            })
          : [];
      return [headingParts.join(' - '), question.question, ...optionLines].join('\n');
    })
    .join('\n\n');
}

function formatRequestAnswers(
  answers: readonly LensPulseRequestSummary['answers'][number][] | null | undefined,
): string {
  if (!answers || answers.length === 0) {
    return '';
  }

  return [
    'Selected answers',
    ...answers.map((answer) => `${answer.questionId}: ${answer.answers.join(', ')}`),
  ].join('\n');
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
  if (normalized === 'reasoning_text' || normalized === 'reasoning_summary_text') {
    return 'reasoning';
  }
  if (
    normalized === 'command_output' ||
    normalized === 'file_change_output' ||
    normalized.endsWith('_output') ||
    normalized.endsWith('_result')
  ) {
    return 'tool';
  }
  return null;
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

function transcriptLabel(kind: TranscriptKind): string {
  switch (kind) {
    case 'user':
      return 'You';
    case 'assistant':
      return 'Assistant';
    case 'reasoning':
      return 'Reasoning';
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
