import type { GitStatusResponse } from './types';
import { t } from '../i18n';
import { escapeHtml } from '../../utils';

function countWorktreeChanges(status: GitStatusResponse): number {
  return (
    status.conflicted.length +
    status.staged.length +
    status.modified.length +
    status.untracked.length
  );
}

export function renderPanelFill(mainText: string, hintText = '', className = ''): string {
  return `<div class="git-panel-fill${className ? ' ' + className : ''}">
    <div class="git-panel-empty-copy">
      <p>${escapeHtml(mainText)}</p>
      ${hintText ? `<p class="git-panel-hint">${escapeHtml(hintText)}</p>` : ''}
    </div>
  </div>`;
}

export function renderSummary(status: GitStatusResponse): string {
  const pills: string[] = [];
  const changeCount = countWorktreeChanges(status);

  if (status.conflicted.length > 0) {
    pills.push(
      `<span class="git-summary-pill git-summary-pill-danger">!${status.conflicted.length}</span>`,
    );
  }
  if (changeCount > 0) {
    pills.push(`<span class="git-summary-pill git-summary-pill-warn">~${changeCount}</span>`);
  }
  if (status.ahead > 0) {
    pills.push(`<span class="git-summary-pill">↑${status.ahead}</span>`);
  }
  if (status.behind > 0) {
    pills.push(`<span class="git-summary-pill">↓${status.behind}</span>`);
  }
  if (status.stashCount > 0) {
    pills.push(
      `<span class="git-summary-pill">${escapeHtml(t('git.stash'))} ${status.stashCount}</span>`,
    );
  }
  if (pills.length === 0) {
    pills.push(
      `<span class="git-summary-pill git-summary-pill-clean">${escapeHtml(t('git.cleanShort'))}</span>`,
    );
  }

  const branch = escapeHtml(status.branch || 'HEAD');
  const repoRoot = escapeHtml(status.repoRoot);
  const repoSubtitle = status.repoRoot
    ? `<div class="git-panel-summary-subtitle" title="${repoRoot}">${repoRoot}</div>`
    : '';

  return `<div class="git-panel-summary">
    <div class="git-panel-summary-title-row">
      <span class="git-panel-summary-title">${branch}</span>
      <span class="git-panel-summary-pills">${pills.join('')}</span>
    </div>
    ${repoSubtitle}
  </div>`;
}
