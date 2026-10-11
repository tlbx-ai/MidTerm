import type { Schemas } from '../../api/types';
import { t } from '../i18n';

export interface FileVisibility {
  showHidden: boolean;
  showIgnored: boolean;
}
const listeners = new Set<() => void>();
let preferences: FileVisibility = { showHidden: false, showIgnored: true };
try {
  const saved: unknown = JSON.parse(localStorage.getItem('tlbx-file-visibility') ?? 'null');
  if (typeof saved === 'object' && saved !== null) {
    const value = saved as Partial<FileVisibility>;
    if (typeof value.showHidden === 'boolean' && typeof value.showIgnored === 'boolean')
      preferences = value as FileVisibility;
  }
} catch {
  /* Storage is optional; native visibility defaults still work. */
}

export function getFileVisibility(): FileVisibility {
  return preferences;
}
export function setFileVisibility(next: FileVisibility): void {
  if (next.showHidden === preferences.showHidden && next.showIgnored === preferences.showIgnored)
    return;
  preferences = next;
  try {
    localStorage.setItem('tlbx-file-visibility', JSON.stringify(next));
  } catch {
    /* In-memory preference remains usable. */
  }
  listeners.forEach((listener) => {
    listener();
  });
}

export function createFileVisibilityControls(onChange: () => void): {
  root: HTMLElement;
  update: (summary: Schemas['FileVisibilitySummary']) => void;
  dispose: () => void;
} {
  const root = document.createElement('div');
  root.className = 'file-visibility-controls';
  const inputs = new Map<keyof FileVisibility, HTMLInputElement>();
  for (const key of ['showHidden', 'showIgnored'] as const) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.fileVisibility = key;
    input.checked = preferences[key];
    input.addEventListener('change', () => {
      setFileVisibility({ ...preferences, [key]: input.checked });
    });
    label.append(input, document.createTextNode(t(`fileBrowser.${key}`)));
    root.appendChild(label);
    inputs.set(key, input);
  }
  const summaryText = document.createElement('span');
  summaryText.className = 'file-visibility-summary';
  summaryText.setAttribute('aria-live', 'polite');
  root.appendChild(summaryText);
  const changed = (): void => {
    inputs.forEach((input, key) => {
      input.checked = preferences[key];
    });
    onChange();
  };
  listeners.add(changed);
  return {
    root,
    dispose: () => {
      listeners.delete(changed);
    },
    update: (summary) => {
      summaryText.textContent = `${summary.shownCount}/${summary.totalCount} ${t('fileBrowser.itemsShown')} · ${summary.excludedCount} ${t('fileBrowser.itemsExcluded')}`;
      if (!summary.ignoreAvailable)
        summaryText.textContent += ` · ${t('fileBrowser.ignoreUnavailable')}`;
      const ignored = inputs.get('showIgnored');
      if (ignored) ignored.disabled = !summary.isGitRepo;
    },
  };
}
