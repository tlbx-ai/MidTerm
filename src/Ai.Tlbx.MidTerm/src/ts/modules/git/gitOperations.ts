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

export function renderGitOperations(state: GitOperationsUi, status: GitStatusResponse): string {
  const disabled = state.busy || state.pending !== null ? ' disabled' : '';
  const message = state.error ?? state.confirmed ?? (state.busy ? t('git.operationBusy') : '');
  return `<section class="git-operations" aria-label="${t('git.commitStaged')}">
    <textarea class="git-commit-message" data-git-commit-message="true" aria-label="${t('git.commitMessage')}" placeholder="${t('git.commitMessage')}" maxlength="65536"${state.busy ? ' readonly' : ''}>${escapeHtml(state.message)}</textarea>
    <div class="git-operation-buttons">
      <button class="git-action-button" data-action="stage-all"${disabled} type="button">${t('git.stageAll')}</button>
      <button class="git-action-button" data-action="unstage-all"${state.busy || state.pending !== null || status.staged.length === 0 ? ' disabled' : ''} type="button">${t('git.unstageAll')}</button>
      <button class="git-action-button" data-action="commit-staged"${canCommit(state, status) ? '' : ' disabled'} type="button">${t('git.commitStaged')}</button>
    </div>
    <div class="git-operation-status" role="${state.error ? 'alert' : 'status'}" aria-live="polite">${escapeHtml(message)}</div>
    ${state.pending && !state.busy ? `<button class="git-action-button" data-action="retry-operation" type="button">${t('git.retryOperation')}</button>` : ''}
  </section>`;
}

export function gitFileAction(path: string, staged: boolean, busy: boolean): string {
  return `<button class="git-action-button git-file-action" data-action="${staged ? 'unstage-file' : 'stage-file'}" data-path="${escapeHtml(path)}"${busy ? ' disabled' : ''} aria-label="${t(staged ? 'git.unstage' : 'git.stage')}: ${escapeHtml(path)}" type="button">${t(staged ? 'git.unstage' : 'git.stage')}</button>`;
}

export function gitSectionAction(section: string, busy: boolean): string {
  if (section === 'conflicts') return '';
  return `<button class="git-action-button git-section-action" data-action="stage-section" data-section="${section}"${busy ? ' disabled' : ''} type="button">${t(section === 'staged' ? 'git.unstageGroup' : 'git.stageGroup')}</button>`;
}

export async function executeGitOperation(
  state: GitOperationsUi,
  request: GitOperationRequest,
): Promise<GitOperationResponse | null> {
  state.busy = true;
  state.pending = request;
  state.error = null;
  state.confirmed = null;
  try {
    const response = await fetch('/api/git/operations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const result = (await response.json()) as GitOperationResponse;
    if (!response.ok || result.state !== 'completed') {
      state.error = `${t('git.operationFailed')}${result.detail ? `\n${result.detail}` : ''}`;
      state.pending = result.state === 'unknown' ? request : null;
    } else {
      if (request.action === 'commit') {
        setGitCommitMessage(state, '');
        state.confirmed = `${t('git.commitCreated')}: ${result.commitHash ?? ''}`;
      } else
        state.confirmed = t(request.action.startsWith('stage') ? 'git.staged' : 'git.unstaged');
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
