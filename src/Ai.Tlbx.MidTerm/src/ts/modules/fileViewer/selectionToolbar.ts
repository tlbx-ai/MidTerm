import { t } from '../i18n';
import { downloadFile, writeTextToClipboard } from './shared';
import { showPathDetails } from './pathDetails';
import { fileStatusPresentation } from '../git/fileStatus';

export interface SelectedFile {
  path: string;
  isDirectory: boolean;
  gitStatus?: string | null | undefined;
}

export function createSelectionToolbar(
  selected: () => SelectedFile[],
  open: (path: string) => void,
  sessionId: () => string | null,
  multiSelect?: { active: () => boolean; toggle: () => void },
): { root: HTMLElement; update: () => void } {
  const root = document.createElement('div');
  root.className = 'file-selection-toolbar';
  const count = document.createElement('span');
  count.className = 'file-selection-count';
  count.setAttribute('aria-live', 'polite');
  const actions = new Map<string, HTMLButtonElement>();
  const actionList = document.createElement('div');
  actionList.className = 'file-selection-read-actions';
  for (const action of [
    ...(multiSelect ? ['selectMultiple'] : []),
    'open',
    'details',
    'copyPaths',
    'download',
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.selectionAction = action;
    button.textContent = t(`fileBrowser.${action}`);
    actions.set(action, button);
    actionList.appendChild(button);
    button.addEventListener('click', () => {
      const menu = button.closest('details');
      if (menu) {
        menu.open = false;
        menu.querySelector<HTMLElement>('summary')?.focus();
      }
      const files = selected();
      const first = files[0];
      if (action === 'selectMultiple') multiSelect?.toggle();
      else if (action === 'open' && files.length === 1 && first) open(first.path);
      else if (action === 'details') {
        void showPathDetails(
          files.map((file) => file.path),
          files.map(
            (file) => fileStatusPresentation(file.gitStatus, file.isDirectory)?.label ?? '',
          ),
        );
      } else if (action === 'copyPaths') {
        void writeTextToClipboard(files.map((file) => file.path).join('\n')).then((copied) => {
          if (!copied) count.textContent = t('fileBrowser.copyFailed');
        });
      } else if (action === 'download' && files.every((file) => !file.isDirectory)) {
        files.forEach((file) => {
          downloadFile(file.path, sessionId());
        });
      }
    });
  }
  root.prepend(count);
  root.append(actionList);
  return {
    root,
    update: () => {
      const files = selected();
      count.textContent = `${files.length} ${t('fileBrowser.selected')}`;
      count.title = `${files.length} ${t('fileBrowser.selected')}`;
      count.setAttribute('aria-label', count.title);
      count.hidden = files.length === 0;
      root.dataset.multiSelect = String(multiSelect?.active() ?? false);
      actions.get('selectMultiple')?.setAttribute('aria-pressed', root.dataset.multiSelect);
      const openButton = actions.get('open');
      if (openButton) openButton.disabled = files.length !== 1;
      const copy = actions.get('copyPaths');
      if (copy) copy.disabled = files.length === 0;
      const details = actions.get('details');
      if (details) details.disabled = files.length === 0;
      const download = actions.get('download');
      if (download)
        download.disabled = files.length === 0 || files.some((file) => file.isDirectory);
    },
  };
}
