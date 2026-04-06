import type { LensAttachmentReference, LensPulseRuntimeNotice } from '../../api/types';
import type { LensPulseEvent, LensPulseSnapshotResponse } from '../../api/client';

export interface SessionLensViewState {
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

export interface PendingLensTurn {
  optimisticId: string;
  turnId: string | null;
  text: string;
  attachments: LensAttachmentReference[];
  submittedAt: string;
  status: 'submitted' | 'accepted';
}

export interface LensActivationTraceEntry {
  tone: HistoryTone;
  meta: string;
  summary: string;
  detail: string;
}

export interface AssistantMarkdownCacheEntry {
  body: string;
  html: string;
  imageCandidates: AssistantImageCandidate[];
  imagePreviews: AssistantImagePreview[];
  imagePreviewResolutionStarted: boolean;
}

export interface AssistantImageCandidate {
  displayText: string;
  normalizedPath: string;
  pathKind: 'absolute' | 'relative';
  line?: number | null;
  column?: number | null;
}

export interface AssistantImagePreview {
  resolvedPath: string;
  displayPath: string;
  mimeType?: string | null;
}

export type HistoryKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool'
  | 'request'
  | 'plan'
  | 'diff'
  | 'system'
  | 'notice';

export type HistoryTone = 'info' | 'positive' | 'warning' | 'attention';
export type LensHistoryActionId = 'retry-lens';
export type LensLayoutMode = 'default' | 'full-width-left';

export interface LensHistoryAction {
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
  busyAnimationOffsetMs?: number | null;
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

export interface HistoryViewportMetrics {
  scrollTop: number;
  clientHeight: number;
  clientWidth: number;
}

export interface HistoryScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export interface HistoryVisibleEntry {
  key: string;
  entry: LensHistoryEntry;
  cluster: ArtifactClusterInfo | null;
  signature: string;
}

export interface HistoryRenderPlan {
  emptyStateText: string | null;
  topSpacerPx: number;
  bottomSpacerPx: number;
  visibleEntries: HistoryVisibleEntry[];
}

export interface HistoryRenderedNode {
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

export interface ArtifactClusterInfo {
  position: 'single' | 'start' | 'middle' | 'end';
  label: string | null;
  count: number;
  onlyTools: boolean;
}

export interface CommandToken {
  text: string;
  kind: 'command' | 'parameter' | 'string' | 'operator' | 'text' | 'whitespace';
}

export interface DiffRenderLine {
  text: string;
  className: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface LensNoticeEntry {
  id: string;
  order: number;
  title: string;
  meta: string;
  notice: LensPulseRuntimeNotice;
}
