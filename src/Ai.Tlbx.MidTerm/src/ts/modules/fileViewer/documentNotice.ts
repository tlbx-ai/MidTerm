import { t } from '../i18n';
import { formatSize } from './rendering';
import type { FileDocument } from './documentApi';

export interface DocumentNavigation {
  read: (full: boolean, offset: number) => Promise<FileDocument>;
  display: (document: FileDocument, previousOffsets: number[]) => void;
  active: () => boolean;
  previousOffsets?: number[];
}

/** Shared text size, encoding and page controls for the tab, modal and dock. */
export function createDocumentNotice(
  snapshot: FileDocument,
  navigation: DocumentNavigation,
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'file-document-notice';
  const meta = document.createElement('span');
  meta.className = 'file-document-metadata';
  const parts = [snapshot.encoding, snapshot.lineEnding.toUpperCase(), formatSize(snapshot.size)];
  if (snapshot.readOnly) parts.push(t('fileViewer.readOnly'));
  if (snapshot.isTruncated)
    parts.push(
      `${formatSize(snapshot.offset)}–${formatSize(snapshot.nextOffset)} / ${formatSize(snapshot.size)}`,
    );
  meta.textContent = parts.join(' | ');
  root.appendChild(meta);
  if (!snapshot.isTruncated) return root;
  const hint = document.createElement('span');
  hint.textContent = snapshot.canLoadFull
    ? t('fileViewer.partialReadOnly')
    : t('fileViewer.largeReadOnly');
  hint.className = 'file-document-hint';
  root.appendChild(hint);
  const actions = document.createElement('div');
  actions.className = 'file-document-actions';
  const error = document.createElement('span');
  error.className = 'file-document-load-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const previous = navigation.previousOffsets ?? [];
  const buttons: HTMLButtonElement[] = [];
  const add = (
    label: string,
    action: string,
    full: boolean,
    offset: number,
    history: number[],
  ): void => {
    const button = document.createElement('button');
    button.className = 'btn-secondary';
    button.type = 'button';
    button.textContent = t(label);
    button.dataset.documentAction = action;
    button.addEventListener('click', () => {
      buttons.forEach((item) => {
        item.disabled = true;
      });
      error.hidden = true;
      void navigation
        .read(full, offset)
        .then((document) => {
          if (!navigation.active()) return;
          navigation.display(document, history);
        })
        .catch((reason: unknown) => {
          if (!navigation.active()) return;
          error.textContent = t('fileViewer.loadFailedRetry');
          error.hidden = false;
          error.title = reason instanceof Error ? reason.message : '';
          buttons.forEach((item) => {
            item.disabled = false;
          });
        });
    });
    buttons.push(button);
    actions.appendChild(button);
  };
  if (previous.length)
    add(
      'fileViewer.previousPage',
      'previous',
      false,
      previous[previous.length - 1] ?? 0,
      previous.slice(0, -1),
    );
  if (snapshot.nextOffset < snapshot.size)
    add('fileViewer.nextPage', 'next', false, snapshot.nextOffset, [...previous, snapshot.offset]);
  if (snapshot.canLoadFull) add('fileViewer.loadForEditing', 'full', true, 0, []);
  root.append(actions, error);
  return root;
}
