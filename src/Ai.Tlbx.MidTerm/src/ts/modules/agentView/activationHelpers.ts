import type { LensAttachmentReference } from '../../api/types';
import { LensHttpError } from '../../api/client';
import type {
  HistoryKind,
  HistoryTone,
  LensActivationIssue,
  LensHistoryAction,
  LensLayoutMode,
  SessionLensViewState,
} from './types';
import { t } from '../i18n';

export const STALE_LENS_ACTIVATION = '__midterm_stale_lens_activation__';

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

export function prettify(value: string): string {
  return value
    .replace(/[_./-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

export function formatAbsoluteTime(value: string): string {
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

export function formatClockTime(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value);
}

export function appendActivationTrace(
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

export function setActivationState(
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

export function describeError(error: unknown): string {
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
    actions,
  };
}

export function shouldShowLensDevErrorDialog(issue: LensActivationIssue | null): boolean {
  return issue?.kind === 'startup-failed';
}

export function ensureLensActivationIsCurrent(
  state: SessionLensViewState,
  activationRunId: number,
): void {
  if (state.debugScenarioActive || state.activationRunId !== activationRunId) {
    throw new Error(STALE_LENS_ACTIVATION);
  }
}

export function isStaleLensActivationError(error: unknown): boolean {
  return error instanceof Error && error.message === STALE_LENS_ACTIVATION;
}

export function toneFromState(state: string | null | undefined): HistoryTone {
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

export function normalizeSnapshotHistoryKind(kind: string | null | undefined): HistoryKind {
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

export function isImageAttachment(attachment: LensAttachmentReference): boolean {
  if (attachment.kind.toLowerCase() === 'image') {
    return true;
  }

  if ((attachment.mimeType || '').toLowerCase().startsWith('image/')) {
    return true;
  }

  return /\.(png|jpe?g|gif|bmp|webp|svg|tiff?|heic|heif|avif)$/i.test(attachment.path);
}

export function buildLensAttachmentUrl(
  sessionId: string,
  attachment: LensAttachmentReference,
): string {
  return (
    `/api/files/view?path=${encodeURIComponent(attachment.path)}` +
    `&sessionId=${encodeURIComponent(sessionId)}`
  );
}

export function resolveAttachmentLabel(attachment: LensAttachmentReference): string {
  if (attachment.displayName?.trim()) {
    return attachment.displayName.trim();
  }

  const normalizedPath = attachment.path.replace(/\\/g, '/');
  const slashIndex = normalizedPath.lastIndexOf('/');
  return slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath;
}

export function normalizeLensProvider(provider: string | null | undefined): string {
  return (provider || '').trim().toLowerCase();
}

export function resolveLensLayoutMode(provider: string | null | undefined): LensLayoutMode {
  return normalizeLensProvider(provider) === 'codex' ? 'full-width-left' : 'default';
}

export function historyLabel(kind: HistoryKind): string {
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
    case 'system':
      return lensText('lens.label.system', 'System');
    case 'notice':
      return lensText('lens.label.error', 'Error');
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
