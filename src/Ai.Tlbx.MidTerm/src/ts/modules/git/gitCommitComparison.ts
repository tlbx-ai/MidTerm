import type { GitCommitDetailsResponse } from './types';
import { escapeHtml } from '../../utils';
import { t, getCurrentLocale } from '../i18n';

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
  let html = `<div class="git-inspector-summary">
    <div class="git-inspector-title-row">
      <span class="git-inspector-title" title="${escapeHtml(commit.subject)}">${escapeHtml(commit.subject || t('git.untitledCommit'))}</span>
    </div>
    <details class="git-commit-metadata"><summary>${escapeHtml(commit.shortHash)} · ${t('git.commitDetails')}</summary>
      <dl class="git-commit-details">
        <dt>${t('git.subject')}</dt><dd data-git-full-subject="true">${escapeHtml(commit.subject)}</dd>
        <dt>${t('git.commitHash')}</dt><dd>${escapeHtml(commit.hash)}</dd>
        <dt>${t('git.author')}</dt><dd>${escapeHtml(commit.author)}</dd>
        <dt>${t('git.authored')}</dt><dd>${escapeHtml(formatGitDate(commit.authoredDate))}</dd>
        <dt>${t('git.committed')}</dt><dd>${escapeHtml(formatGitDate(commit.committedDate))}</dd>
        <dt>${t('git.parents')}</dt><dd>${commit.parentHashes.map((hash) => escapeHtml(hash)).join('<br>') || t('git.emptyTree')}</dd>
      </dl>
    </details>
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
  return parsed.toLocaleString(getCurrentLocale());
}
