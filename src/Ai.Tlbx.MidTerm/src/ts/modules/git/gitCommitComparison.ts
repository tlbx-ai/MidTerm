import type { GitCommitDetailsResponse } from './types';
import { escapeHtml } from '../../utils';
import { t } from '../i18n';

export function captureCommitParentFocus(
  container: HTMLElement,
  stillOwned: () => boolean,
): () => void {
  const wasFocused =
    typeof document !== 'undefined' &&
    document.activeElement === container.querySelector('.git-commit-parent');
  return () => {
    if (wasFocused && stillOwned() && document.activeElement === document.body)
      container.querySelector<HTMLElement>('.git-commit-parent')?.focus({ preventScroll: true });
  };
}

export function renderCommitComparison(commit: GitCommitDetailsResponse): string {
  const label = t('git.compareWith');
  if (commit.parentHashes.length === 0)
    return `<p class="git-commit-comparison">${label}: ${t('git.emptyTree')}</p>`;
  if (commit.parentHashes.length === 1)
    return `<p class="git-commit-comparison">${label}: <span title="${escapeHtml(commit.parentHashes[0] ?? '')}">${t('git.parentVersion')} 1 · ${escapeHtml(commit.parentHashes[0]?.slice(0, 8) ?? '')}</span></p>`;
  return `<label class="git-commit-comparison">${label}
    <select class="git-commit-parent" data-git-commit-parent="true" data-commit-hash="${escapeHtml(commit.hash)}" aria-label="${label}">
      ${commit.parentHashes.map((hash, index) => `<option value="${index}" title="${escapeHtml(hash)}"${index === (commit.comparedParentIndex ?? 0) ? ' selected' : ''}>${t('git.parentVersion')} ${index + 1} · ${escapeHtml(hash.slice(0, 8))}</option>`).join('')}
    </select>
  </label>`;
}

export function renderEmptyComparison(commit: GitCommitDetailsResponse): string {
  return commit.files.length === 0 && !commit.isTruncated
    ? `<div class="git-patch-empty">${t('git.noComparedChanges')}</div>`
    : '';
}

export function renderCommitMetadata(commit: GitCommitDetailsResponse): string {
  const bodyHtml = commit.body.trim()
    ? `<pre class="git-commit-body">${escapeHtml(commit.body.trim())}</pre>`
    : '';
  const parentsHtml =
    commit.parentHashes.length > 0
      ? `<div class="git-commit-detail-row"><span class="git-commit-detail-label">Parents</span><span>${escapeHtml(commit.parentHashes.join(' '))}</span></div>`
      : '';

  let html = `<div class="git-inspector-summary">
    <div class="git-inspector-title-row">
      <span class="git-inspector-title">${escapeHtml(commit.subject || commit.shortHash)}</span>
      <span class="git-summary-pill">${escapeHtml(commit.shortHash)}</span>
    </div>
    <div class="git-commit-detail-row"><span class="git-commit-detail-label">Author</span><span>${escapeHtml(commit.author)}</span></div>
    <div class="git-commit-detail-row"><span class="git-commit-detail-label">Authored</span><span>${escapeHtml(formatGitDate(commit.authoredDate))}</span></div>
    <div class="git-commit-detail-row"><span class="git-commit-detail-label">Committed</span><span>${escapeHtml(formatGitDate(commit.committedDate))}</span></div>
    ${parentsHtml}
  </div>`;
  html += bodyHtml;
  return html;
}

export function formatGitDate(value: string): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}
