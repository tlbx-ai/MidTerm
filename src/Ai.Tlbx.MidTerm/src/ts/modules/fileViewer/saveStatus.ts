import { t } from '../i18n';
import { registerBackButtonLayer } from '../navigation/backButtonGuard';
import { showAlert, showConfirm } from '../../utils/dialog';
import { FileDocumentError, type FileDocument } from './documentApi';
import type { FileEditState } from './editState';
import { createLineNumberedViewer } from './rendering';

export interface FileSaveActions {
  readLatest: () => Promise<FileDocument>;
  replace: (document: FileDocument) => void;
  active: () => boolean;
}

export function createFileSaveStatus(edit: FileEditState, actions: FileSaveActions): HTMLElement {
  const root = document.createElement('div');
  root.className = 'file-save-status';
  const label = document.createElement('span');
  label.setAttribute('role', 'status');
  label.setAttribute('aria-live', 'polite');
  root.appendChild(label);
  const buttons = document.createElement('div');
  buttons.className = 'file-save-status-actions';
  const reload = actionButton('fileViewer.reloadDisk', 'reload');
  const compare = actionButton('fileViewer.compare', 'compare');
  const retry = actionButton('fileViewer.retrySave', 'retry');
  const exportDraft = actionButton('fileViewer.downloadDraft', 'download-draft');
  buttons.appendChild(reload);
  buttons.appendChild(compare);
  buttons.appendChild(retry);
  buttons.appendChild(exportDraft);
  root.appendChild(buttons);
  const render = (): void => {
    const conflict =
      edit.lastError instanceof FileDocumentError &&
      (edit.lastError.code === 'changed' || edit.lastError.code === 'changed_during_save');
    const message = edit.saving
      ? t('modal.saving')
      : (edit.lastError?.message ??
        t(
          edit.dirty
            ? 'fileViewer.unsavedTitle'
            : edit.saved
              ? 'fileViewer.saved'
              : 'fileViewer.ready',
        ));
    if (label.textContent !== message) label.textContent = message;
    buttons.hidden = !edit.lastError;
    reload.hidden = !conflict;
    compare.hidden = !conflict;
    retry.hidden = conflict;
    exportDraft.hidden = !edit.dirty;
    reload.disabled = edit.saving;
    compare.disabled = edit.saving;
    retry.disabled = edit.saving || !edit.dirty;
    exportDraft.disabled = edit.saving;
    const name = `file-save-status${edit.lastError ? ' file-save-status-error' : ''}`;
    if (root.className !== name) root.className = name;
    root.dataset.fileSaveState = saveState(edit);
    root.setAttribute('aria-busy', String(edit.saving));
    root.dataset.fileErrorCode =
      edit.lastError instanceof FileDocumentError ? edit.lastError.code : '';
  };
  edit.subscribe(render);
  render();
  retry.addEventListener('click', () => {
    void edit.save().catch(() => {});
  });
  exportDraft.addEventListener('click', () => {
    downloadDraft(edit);
  });
  reload.addEventListener('click', () => {
    void reloadFromDisk(edit, actions).catch((error: unknown) =>
      showAlert(error instanceof Error ? error.message : t('fileViewer.saveFailed')),
    );
  });
  compare.addEventListener('click', () => {
    void compareWithDisk(edit, actions).catch((error: unknown) =>
      showAlert(error instanceof Error ? error.message : t('fileViewer.saveFailed')),
    );
  });
  return root;
}

function saveState(edit: FileEditState): string {
  if (edit.saving) return 'saving';
  if (edit.lastError)
    return edit.lastError instanceof FileDocumentError && edit.lastError.outcomeUnknown
      ? 'unknown'
      : 'error';
  if (edit.dirty) return 'unsaved';
  return edit.saved ? 'saved' : 'ready';
}

function downloadDraft(edit: FileEditState): void {
  const url = URL.createObjectURL(new Blob([edit.content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = edit.path.split(/[\\/]/).pop() ?? 'draft.txt';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

function actionButton(key: string, action: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-secondary';
  button.dataset.fileConflictAction = action;
  button.textContent = t(key);
  return button;
}

async function reloadFromDisk(edit: FileEditState, actions: FileSaveActions): Promise<void> {
  if (edit.dirty && !(await showConfirm(t('fileViewer.reloadConfirm'), { danger: true }))) return;
  const latest = await actions.readLatest();
  if (actions.active()) actions.replace(latest);
}

async function compareWithDisk(edit: FileEditState, actions: FileSaveActions): Promise<void> {
  const latest = await actions.readLatest();
  if (!actions.active()) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay file-conflict-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'modal-content file-conflict-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', t('fileViewer.compare'));
  const heading = document.createElement('h3');
  heading.textContent = edit.path;
  const columns = document.createElement('div');
  columns.className = 'file-conflict-columns';
  for (const [name, content] of [
    [t('fileViewer.yourDraft'), edit.content],
    [t('fileViewer.onDisk'), latest.content],
  ]) {
    const column = document.createElement('section');
    const title = document.createElement('h4');
    title.textContent = name ?? '';
    column.append(title, createLineNumberedViewer(content ?? '').root);
    columns.appendChild(column);
  }
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  const cancel = actionButton('dialog.cancel', 'close');
  const overwrite = actionButton('fileViewer.overwriteReviewed', 'overwrite');
  overwrite.disabled = latest.readOnly || !latest.version;
  footer.append(cancel, overwrite);
  dialog.append(heading, columns, footer);
  overlay.appendChild(dialog);
  const previousFocus = document.activeElement;
  let release: (() => void) | null = null;
  let busy = false;
  const close = (): void => {
    if (busy) return;
    release?.();
    overlay.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  };
  cancel.addEventListener('click', close);
  overwrite.addEventListener('click', () => {
    void (async () => {
      if (
        !(await showConfirm(t('fileViewer.overwriteConfirm'), { danger: true })) ||
        !actions.active() ||
        !latest.version
      )
        return;
      busy = true;
      overwrite.disabled = true;
      cancel.disabled = true;
      try {
        const saved = await edit.save(latest.version);
        busy = false;
        if (saved) close();
      } catch (error) {
        busy = false;
        await showAlert(error instanceof Error ? error.message : t('fileViewer.saveFailed'));
      } finally {
        overwrite.disabled = false;
        cancel.disabled = false;
      }
    })();
  });
  overlay.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      if (!busy) (document.activeElement === cancel ? overwrite : cancel).focus();
    }
  });
  document.body.appendChild(overlay);
  release = registerBackButtonLayer(close);
  cancel.focus();
}
