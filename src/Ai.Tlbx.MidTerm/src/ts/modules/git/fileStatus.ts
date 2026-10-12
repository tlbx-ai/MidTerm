import { t } from '../i18n';

const statuses = {
  modified: 'M',
  untracked: 'U',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  conflicted: '!',
  copied: 'C',
  'type-changed': 'T',
} as const;

type FileStatus = keyof typeof statuses;

export interface FileStatusPresentation {
  status: FileStatus;
  letter: string;
  label: string;
}

// Files receives compact backend badges; Git receives semantic status names.
// Both surfaces use this one presentation, including non-color descriptions.
export function fileStatusPresentation(
  value: string | null | undefined,
  directory = false,
): FileStatusPresentation | null {
  if (!value) return null;
  const normalized = value === 'unmerged' ? 'conflicted' : value === '?' ? 'untracked' : value;
  const status = (Object.keys(statuses) as FileStatus[]).find(
    (key) => key === normalized || statuses[key] === normalized,
  );
  if (!status) return null;
  const label = t(`git.fileStatus.${status}`);
  return {
    status,
    letter: statuses[status],
    label: directory ? `${t('git.fileStatus.contains')}: ${label}` : label,
  };
}

let badgeId = 0;

export function patchFileStatusBadge(
  badge: HTMLElement,
  row: HTMLElement,
  value: string | null | undefined,
  directory = false,
): void {
  const presentation = fileStatusPresentation(value, directory);
  badge.textContent = presentation?.letter ?? '';
  if (presentation) {
    badge.id ||= `file-status-${++badgeId}`;
    badge.dataset.gitStatus = presentation.status;
    badge.title = presentation.label;
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', presentation.label);
    row.setAttribute('aria-describedby', badge.id);
  } else {
    delete badge.dataset.gitStatus;
    badge.removeAttribute('title');
    badge.removeAttribute('role');
    badge.removeAttribute('aria-label');
    row.removeAttribute('aria-describedby');
  }
}
