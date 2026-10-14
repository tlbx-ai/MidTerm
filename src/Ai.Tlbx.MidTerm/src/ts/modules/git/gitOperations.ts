import { t } from '../i18n';
import { escapeHtml } from '../../utils';
import type {
  GitOperationRequest,
  GitOperationResponse,
  GitStatusResponse,
  GitDiffViewResponse,
  GitFileEntry,
} from './types';

export function buildGitSelectionRequest(
  sessionId: string,
  root: string,
  path: string,
  staged: boolean,
  diff: GitDiffViewResponse,
  selected: ReadonlySet<string>,
  hunk?: number,
): GitOperationRequest {
  return {
    sessionId,
    repoRoot: root,
    operationId: crypto.randomUUID(),
    action: staged ? 'unstage-selection' : 'stage-selection',
    paths: [path],
    all: false,
    expectedIndexVersion: diff.indexVersion ?? '',
    expectedPatchVersion: diff.patchVersion ?? '',
    selectedHunks: hunk === undefined ? [] : [hunk],
    selectedLines:
      hunk === undefined
        ? [...selected].map((id) => {
            const [selectedHunk, line] = id.split(':').map(Number);
            return { hunk: selectedHunk ?? -1, line: line ?? -1 };
          })
        : [],
  };
}

export interface GitOperationsUi {
  message: string;
  busy: boolean;
  pending: GitOperationRequest | null;
  error: string | null;
  confirmed: string | null;
  draftKey: string;
  lastResult?: GitOperationResponse | null;
}

export function createGitOperationsUi(sessionId: string, root?: string): GitOperationsUi {
  const draftKey = `tlbx-git-commit:${sessionId}:${root ?? ''}`;
  let message = '';
  try {
    message = localStorage.getItem(draftKey) ?? '';
  } catch {
    /* In-memory drafts still work. */
  }
  return { message, busy: false, pending: null, error: null, confirmed: null, draftKey };
}

export function setGitCommitMessage(state: GitOperationsUi, message: string): void {
  state.message = message;
  try {
    localStorage.setItem(state.draftKey, message);
  } catch {
    /* The current draft remains in memory. */
  }
}

export function canCommit(state: GitOperationsUi, status: GitStatusResponse): boolean {
  return (
    !state.busy &&
    state.pending === null &&
    state.message.trim().length > 0 &&
    status.staged.length > 0 &&
    status.conflicted.length === 0 &&
    !!status.indexVersion
  );
}

export function renderGitOperations(
  state: GitOperationsUi,
  status: GitStatusResponse,
  blocked = false,
): string {
  const message = operationMessage(state);
  const [summary, ...details] = message.split('\n');
  const hasChanges =
    status.staged.length +
      status.modified.length +
      status.untracked.length +
      status.conflicted.length >
    0;
  if (!hasChanges && !state.message) return renderOperationNotice(state, summary ?? '', details);
  return `<section class="git-operations" aria-label="${t('git.commitStaged')}">
    <textarea class="git-commit-message" data-git-commit-message="true" aria-label="${t('git.commitMessage')}" placeholder="${t('git.commitMessage')}" maxlength="65536"${state.busy ? ' readonly' : ''}>${escapeHtml(state.message)}</textarea>
    ${renderOperationButtons(state, status, blocked)}
    <div class="git-operation-status" role="${state.error ? 'alert' : 'status'}" aria-live="polite">${escapeHtml(summary ?? '')}</div>
    ${details.length ? `<details class="git-operation-details"><summary>${t('git.errorDetails')}</summary><pre>${escapeHtml(details.join('\n'))}</pre></details>` : ''}
    ${state.pending && !state.busy ? `<button class="git-action-button" data-action="retry-operation" type="button">${t('git.retryOperation')}</button>` : ''}
  </section>`;
}

function renderOperationNotice(state: GitOperationsUi, summary: string, details: string[]): string {
  if (!summary && !state.pending) return '';
  return `<section class="git-operations git-operations-notice"><div class="git-operation-status" role="${state.error ? 'alert' : 'status'}" aria-live="polite">${escapeHtml(summary)}</div>${details.length ? `<details class="git-operation-details"><summary>${t('git.errorDetails')}</summary><pre>${escapeHtml(details.join('\n'))}</pre></details>` : ''}${state.pending && !state.busy ? `<button class="git-action-button" data-action="retry-operation" type="button">${t('git.retryOperation')}</button>` : ''}</section>`;
}

function renderOperationButtons(
  state: GitOperationsUi,
  status: GitStatusResponse,
  blocked: boolean,
): string {
  const busy = blocked || state.busy || state.pending !== null;
  return `<div class="git-operation-buttons">
    <button class="btn-primary git-commit-button" data-action="commit-staged"${!blocked && canCommit(state, status) ? '' : ' disabled'} title="${t('git.commitStaged')}" type="button">${t('git.commit')}</button>
    <details class="git-operation-menu"><summary aria-label="${t('git.workspace')}" title="${t('git.workspace')}">⋯</summary><div class="git-operation-menu-items">
    <button class="git-action-button" data-action="stage-all"${busy ? ' disabled' : ''} type="button">${t('git.stageAll')}</button>
    <button class="git-action-button" data-action="unstage-all"${busy || status.staged.length === 0 ? ' disabled' : ''} type="button">${t('git.unstageAll')}</button>
    </div></details>
  </div>`;
}

export function gitFileAction(
  path: string,
  staged: boolean,
  busy: boolean,
  inspector = false,
): string {
  const label = `${t(staged ? 'git.unstage' : 'git.stage')}: ${escapeHtml(path)}`;
  const action = `${staged ? 'unstage' : 'stage'}-${inspector ? 'inspected-' : ''}file`;
  return `<button class="git-action-button git-file-action" data-action="${action}" data-path="${escapeHtml(path)}"${busy ? ' disabled' : ''} aria-label="${label}" title="${label}" type="button"><span aria-hidden="true">${staged ? '−' : '+'}</span></button>`;
}

export function gitSectionAction(section: string, busy: boolean): string {
  if (section === 'conflicts') return '';
  const label = t(section === 'staged' ? 'git.unstageGroup' : 'git.stageGroup');
  return `<button class="git-action-button git-section-action" data-action="stage-section" data-section="${section}"${busy ? ' disabled' : ''} aria-label="${label}" title="${label}" type="button"><span aria-hidden="true">${section === 'staged' ? '−' : '+'}</span></button>`;
}

export function renderGitInspectorAction(
  selection: { kind: string; path?: string; scope?: string; status?: string } | null,
  busy: boolean,
): string {
  if (selection?.kind !== 'file' || !selection.path) return '';
  if (selection.status === 'unmerged' || selection.status === 'conflicted')
    return `<button class="git-action-button" data-action="resolve-conflict" data-path="${escapeHtml(selection.path)}"${busy ? ' disabled' : ''} type="button">${t('git.resolveConflict')}</button>`;
  return gitFileAction(selection.path, selection.scope === 'staged', busy, true);
}

export async function executeGitOperation(
  state: GitOperationsUi,
  request: GitOperationRequest,
): Promise<GitOperationResponse | null> {
  state.busy = true;
  state.pending = request;
  state.error = null;
  state.confirmed = null;
  state.lastResult = null;
  try {
    const response = await fetch('/api/git/operations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const result = (await response.json()) as GitOperationResponse;
    state.lastResult = result;
    if (!response.ok || result.state !== 'completed') {
      state.error = `${gitOperationSummary(result)}${result.detail ? `\n${result.detail}` : ''}`;
      state.pending = result.state === 'unknown' ? request : null;
    } else {
      if (request.action === 'commit') {
        if (request.message === state.message) setGitCommitMessage(state, '');
        state.confirmed = `${t('git.commitCreated')}: ${result.commitHash ?? ''}`;
      } else if (request.action === 'stage' || request.action === 'stage-selection')
        state.confirmed = t('git.staged');
      else if (request.action === 'unstage' || request.action === 'unstage-selection')
        state.confirmed = t('git.unstaged');
      else state.confirmed = t('git.operationCompleted');
      state.pending = null;
    }
    return result;
  } catch {
    state.error = t('git.outcomeUnknown');
    return null;
  } finally {
    state.busy = false;
  }
}

export function gitOperationSummary(result: GitOperationResponse | null): string {
  if (!result || result.state === 'unknown') return t('git.outcomeUnknown');
  if (result.state === 'completed') return t('git.operationCompleted');
  if (result.state === 'conflicted') return t('git.conflictRequiresResolution');
  const keys: Record<string, string> = {
    identity_missing: 'git.identityMissing',
    git_locked: 'git.locked',
    dirty_working_tree: 'git.dirtyWorkingTree',
    workspace_changed: 'git.reviewChanged',
    index_changed: 'git.reviewChanged',
    head_changed: 'git.reviewChanged',
    conflict_changed: 'git.reviewChanged',
    diff_changed: 'git.reviewChanged',
    conflict_markers: 'git.removeMarkers',
    permission_denied: 'git.permissionDenied',
    repository_unbound: 'git.repositoryUnbound',
    invalid_branch: 'git.invalidBranch',
    remote_required: 'git.selectRemote',
  };
  return t(keys[result.errorCode ?? ''] ?? 'git.operationFailed');
}

function operationMessage(state: GitOperationsUi): string {
  const result = state.lastResult;
  if (state.error && result)
    return gitOperationSummary(result) + (result.detail ? '\n' + result.detail : '');
  if (state.error && state.pending) return t('git.outcomeUnknown');
  if (state.confirmed && result) return confirmedOperationMessage(result);
  return state.error ?? state.confirmed ?? (state.busy ? t('git.operationBusy') : '');
}

function confirmedOperationMessage(result: GitOperationResponse): string {
  if (result.action === 'commit') return `${t('git.commitCreated')}: ${result.commitHash ?? ''}`;
  const keys: Record<string, string> = {
    stage: 'git.staged',
    'stage-selection': 'git.staged',
    unstage: 'git.unstaged',
    'unstage-selection': 'git.unstaged',
  };
  return t(keys[result.action] ?? 'git.operationCompleted');
}

export function buildGitMutationRequest(
  sessionId: string,
  message: string,
  data: DOMStringMap,
  status: GitStatusResponse,
): GitOperationRequest {
  let action: GitOperationRequest['action'] =
    data.action === 'commit-staged'
      ? 'commit'
      : data.action?.startsWith('unstage')
        ? 'unstage'
        : 'stage';
  let paths = data.path ? [data.path] : [];
  if (data.action === 'stage-section') {
    const section = data.section;
    action = section === 'staged' ? 'unstage' : 'stage';
    const entries = gitSectionFiles(status, section ?? '');
    paths = entries.map((file) => file.path);
  }
  const root = status.repoRoot;
  const request: GitOperationRequest = {
    sessionId: sessionId,
    repoRoot: root,
    operationId: crypto.randomUUID(),
    action,
    paths,
    all: data.action === 'stage-all' || data.action === 'unstage-all',
  };
  if (action === 'commit') {
    request.message = message;
    request.expectedIndexVersion = status.indexVersion ?? '';
    request.expectedHead = status.headHash ?? '';
  }
  return request;
}

export function gitSectionFiles(status: GitStatusResponse, section: string): GitFileEntry[] {
  if (section === 'staged') return status.staged;
  if (section === 'untracked') return status.untracked;
  if (section === 'conflicts') return status.conflicted;
  return status.modified;
}
