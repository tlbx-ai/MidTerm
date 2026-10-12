import { t } from '../i18n';
import { operationDialog } from './operationDialog';
import { getFileName, joinPath } from './rendering';
import { writeTextToClipboard } from './shared';

export function repositoryFilePath(root: string, path: string): string {
  return joinPath(root, path.replace(/\//g, root.includes('\\') ? '\\' : '/'));
}

/** Full selectable paths remain readable on touch and with keyboard focus. */
export async function showPathDetails(paths: string[], descriptions?: string[]): Promise<void> {
  if (paths.length === 0) return;
  const message = paths
    .map(
      (path, index) =>
        `${t('fileBrowser.name')}: ${getFileName(path)}\n${t('fileBrowser.fullPath')}: ${path}${descriptions?.[index] ? `\n${descriptions[index]}` : ''}`,
    )
    .join('\n\n');
  const choice = await operationDialog(t('fileBrowser.details'), message, [
    { value: 'copy', label: t('fileBrowser.copyPaths') },
  ]);
  if (choice?.action === 'copy' && !(await writeTextToClipboard(paths.join('\n'))))
    await operationDialog(t('fileBrowser.copyFailed'), message, []);
}

export function pathDetailsButton(paths: () => string[]): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-path-details';
  button.dataset.pathDetails = 'true';
  button.textContent = t('fileBrowser.details');
  button.addEventListener('click', () => {
    void showPathDetails(paths());
  });
  return button;
}
