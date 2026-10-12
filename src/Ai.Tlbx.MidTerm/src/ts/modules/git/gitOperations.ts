import { t } from '../i18n';
import { escapeHtml } from '../../utils';
import type { GitOperationRequest, GitOperationResponse, GitStatusResponse } from './types';

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
      } else state.confirmed = t(request.action === 'stage' ? 'git.staged' : 'git.unstaged');
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
