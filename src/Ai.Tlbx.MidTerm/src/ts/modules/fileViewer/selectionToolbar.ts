import { t } from '../i18n';
import { downloadFile, writeTextToClipboard } from './shared';
import { showPathDetails } from './pathDetails';

export interface SelectedFile {
  path: string;
  isDirectory: boolean;
}

export function createSelectionToolbar(
  selected: () => SelectedFile[],
  open: (path: string) => void,
  sessionId: () => string | null,
): { root: HTMLElement; update: () => void } {
  const root = document.createElement('div');
  root.className = 'file-selection-toolbar';
  const count = document.createElement('span');
  count.setAttribute('aria-live', 'polite');
  const actions = new Map<string, HTMLButtonElement>();
  for (const action of ['open', 'details', 'copyPaths', 'download']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.selectionAction = action;
    button.textContent = t(`fileBrowser.${action}`);
    actions.set(action, button);
    root.appendChild(button);
    button.addEventListener('click', () => {
      const files = selected();
      const first = files[0];
      if (action === 'open' && files.length === 1 && first) open(first.path);
      else if (action === 'details') {
        void showPathDetails(files.map((file) => file.path));
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
  return {
    root,
    update: () => {
      const files = selected();
      count.textContent = `${files.length} ${t('fileBrowser.selected')}`;
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
