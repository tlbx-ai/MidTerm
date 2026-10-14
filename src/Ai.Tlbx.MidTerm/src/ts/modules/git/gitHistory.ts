import { t } from '../i18n';
import { escapeHtml } from '../../utils';
import { formatGitDate } from './gitCommitComparison';
import type { GitLogEntry } from './types';

interface GitHistoryState {
  historyEntries: GitLogEntry[];
  historyLoading: boolean;
  historyError: string | null;
  historyFocusedHash: string | null;
  hasMoreHistory: boolean;
  expandedSections: ReadonlySet<string>;
  selection: { kind: string; hash?: string } | null;
}

export function renderCommitsSection(state: GitHistoryState, fill = false): string {
  const commits = state.historyEntries;
  if (commits.length === 0) return '';
  const expanded = state.expandedSections.has('commits');
  const selectedHash = state.selection?.hash ?? null;
  const preferred = state.historyFocusedHash ?? selectedHash;
  const focused = commits.some((commit) => commit.hash === preferred)
    ? preferred
    : commits[0]?.hash;
  return `<section class="git-commits-section${fill ? ' git-commits-fill' : ''}${expanded ? '' : ' git-commits-collapsed'}">
    <button class="git-section-toggle" data-action="toggle-section" data-section="commits" aria-expanded="${expanded}" type="button">${t('git.recentCommits')} <span class="git-section-chevron">${expanded ? '▾' : '▸'}</span></button>
    ${
      expanded
        ? `<div class="git-commits-list" role="listbox" aria-label="${t('git.recentCommits')}">${commits
            .map((commit) => {
              const meta = [commit.author, formatGitDate(commit.date)]
                .filter(Boolean)
                .map(escapeHtml)
                .join(' · ');
              const selected = selectedHash === commit.hash;
              return `<button class="git-commit-entry${selected ? ' git-commit-entry-selected' : ''}" role="option" aria-selected="${selected}" tabindex="${focused === commit.hash ? 0 : -1}" data-action="open-commit" data-hash="${escapeHtml(commit.hash)}" title="${escapeHtml(commit.message)}" type="button"><span class="git-commit-main"><span class="git-commit-msg">${escapeHtml(commit.message || t('git.untitledCommit'))}</span><span class="git-commit-hash">${escapeHtml(commit.shortHash)}</span></span><span class="git-commit-meta">${meta}</span></button>`;
            })
            .join('')}</div>${renderHistoryTail(state)}`
        : ''
    }
  </section>`;
}

export function handleGitHistoryKey(
  state: GitHistoryState,
  event: KeyboardEvent,
  container: HTMLElement,
): void {
  if (!(event.target instanceof HTMLElement) || !event.target.matches('.git-commit-entry')) return;
  const rows = [...container.querySelectorAll<HTMLElement>('.git-commit-entry')];
  const index = rows.indexOf(event.target);
  const offsets: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 };
  let next = index;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = rows.length - 1;
  else if (offsets[event.key] !== undefined) next += offsets[event.key] ?? 0;
  else return;
  const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
  if (!row) return;
  state.historyFocusedHash = row.dataset.hash ?? null;
  rows.forEach((item) => {
    item.tabIndex = item === row ? 0 : -1;
  });
  row.focus();
  event.preventDefault();
  event.stopPropagation();
}

function renderHistoryTail(state: GitHistoryState): string {
  const error = state.historyError
    ? `<p class="git-history-error" role="alert">${escapeHtml(state.historyError)}</p>`
    : '';
  return (
    error +
    (state.hasMoreHistory
      ? `<button class="git-history-more" data-action="load-more-history"${state.historyLoading ? ' disabled aria-busy="true"' : ''} type="button">${t(state.historyLoading ? 'git.loading' : 'git.loadMoreHistory')}</button>`
      : '')
  );
}
