import { t } from '../i18n';
import { escapeHtml } from '../../utils';
import type { GitStatusResponse, GitStatusReadResult } from './types';

export interface GitReadUi {
  phase: 'loading' | 'ready' | 'no-repo' | 'error' | 'stale';
  sequence: number;
  message: string;
  detail: string;
  lastReceived: number | null;
}
export function createGitReadUi(): GitReadUi {
  return { phase: 'loading', sequence: 0, message: '', detail: '', lastReceived: null };
}
export function hasReadableGitData(status: GitStatusResponse | null): boolean {
  return (
    !!status &&
    !!(
      status.branch ||
      status.staged.length ||
      status.modified.length ||
      status.untracked.length ||
      status.conflicted.length ||
      status.recentCommits.length
    )
  );
}
export function acceptGitRead(
  ui: GitReadUi,
  result: GitStatusReadResult,
  previous: GitStatusResponse | null,
): GitStatusResponse | null {
  if (!result.ok) {
    markGitReadFailure(ui, previous, httpMessage(result.httpStatus));
    ui.detail = result.detail;
    return previous;
  }
  const status = result.status;
  if (status.readState === 'error' || status.readState === 'stale') {
    markGitReadFailure(
      ui,
      hasReadableGitData(status) ? status : previous,
      status.errorCode === 'repository_unbound' ? t('git.repositoryUnbound') : t('git.readFailed'),
    );
    ui.detail = status.errorDetail ?? '';
    return hasReadableGitData(status) ? status : previous;
  }
  if (status.readState === 'no-repo' || !hasReadableGitData(status)) {
    ui.phase = 'no-repo';
    ui.message = '';
    return null;
  }
  ui.phase = 'ready';
  ui.message = '';
  ui.detail = '';
  ui.lastReceived = Date.now();
  return status;
}
export function markGitReadFailure(
  ui: GitReadUi,
  status: GitStatusResponse | null,
  message: string,
): void {
  ui.phase = hasReadableGitData(status) ? 'stale' : 'error';
  ui.message = message;
  ui.detail = '';
}
function httpMessage(status: number): string {
  if (status === 401) return t('git.authenticationRequired');
  if (status === 403) return t('git.repositoryUnbound');
  if (status === 404) return t('git.repositoryUnavailable');
  if (status === 0) return t('git.offlineStatus');
  return `${t('git.readFailed')} (HTTP ${status})`;
}
export function renderGitReadState(ui: GitReadUi): string {
  if (ui.phase === 'ready' || ui.phase === 'no-repo') return '';
  if (ui.phase === 'loading')
    return `<div class="git-read-state" data-read-state="loading" role="status" aria-live="polite">${t('git.loadingStatus')}</div>`;
  const previous =
    ui.phase === 'stale'
      ? `<span>${t('git.showingPreviousStatus')}${ui.lastReceived ? ` · ${escapeHtml(new Date(ui.lastReceived).toLocaleTimeString())}` : ''}</span>`
      : '';
  const details = ui.detail
    ? `<details><summary>${t('fileBrowser.details')}</summary><pre>${escapeHtml(ui.detail.slice(0, 2000))}</pre></details>`
    : '';
  return `<div class="git-read-state" data-read-state="${ui.phase}" role="alert"><span>${escapeHtml(ui.message)}</span>${previous}${details}<button class="git-action-button" data-action="retry-git-status" type="button">${t('git.retryStatus')}</button></div>`;
}
