import { t } from '../i18n';
import { registerBackButtonLayer } from '../navigation/backButtonGuard';
import { escapeHtml } from '../../utils';

/** An edit belongs to a document, independently of the element presenting it. */
export class FileEditState {
  private savedContent: string;
  private pendingSave: Promise<boolean> | null = null;
  private currentContent: string;
  private readonly listeners = new Set<() => void>();

  public constructor(
    public readonly path: string,
    initialContent: string,
    private readonly write: (content: string) => Promise<void>,
  ) {
    this.currentContent = initialContent;
    this.savedContent = initialContent;
  }

  public get content(): string {
    return this.currentContent;
  }

  public set content(value: string) {
    if (value === this.currentContent) return;
    this.currentContent = value;
    this.notify();
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  public get dirty(): boolean {
    return this.content !== this.savedContent;
  }

  public get saving(): boolean {
    return this.pendingSave !== null;
  }

  public discard(): void {
    this.content = this.savedContent;
  }

  public save(): Promise<boolean> {
    if (this.pendingSave) return this.pendingSave;
    if (!this.dirty) return Promise.resolve(true);

    const snapshot = this.content;
    this.pendingSave = this.write(snapshot)
      .then(() => {
        // Keystrokes received while the request was in flight remain unsaved.
        this.savedContent = snapshot;
        return !this.dirty;
      })
      .finally(() => {
        this.pendingSave = null;
        this.notify();
      });
    this.notify();
    return this.pendingSave;
  }
}

const activeEdits = new Map<HTMLElement, FileEditState>();
const editSessions = new WeakMap<FileEditState, string>();
const pendingDecisions = new WeakMap<FileEditState, Promise<boolean>>();
let unloadGuardInstalled = false;

export function trackFileEdits(owner: HTMLElement, edit: FileEditState, sessionId = ''): void {
  activeEdits.set(owner, edit);
  editSessions.set(edit, sessionId);
  if (!unloadGuardInstalled && typeof window !== 'undefined') {
    window.addEventListener('beforeunload', (event) => {
      if (![...activeEdits.values()].some((state) => state.dirty)) return;
      event.preventDefault();
    });
    unloadGuardInstalled = true;
  }
}

export function hasDirtySessionFiles(sessionId: string): boolean {
  return [...activeEdits.values()].some(
    (edit) => editSessions.get(edit) === sessionId && edit.dirty,
  );
}

export async function confirmSessionFileNavigation(sessionId: string): Promise<boolean> {
  for (const [owner, edit] of activeEdits) {
    if (editSessions.get(edit) === sessionId && !(await confirmFileNavigation(owner))) return false;
  }
  return !hasDirtySessionFiles(sessionId);
}

export function releaseFileEdits(owner: HTMLElement): void {
  activeEdits.delete(owner);
}

export function confirmFileNavigation(owner: HTMLElement): Promise<boolean> {
  const edit = activeEdits.get(owner);
  if (!edit?.dirty) return Promise.resolve(true);
  const pending = pendingDecisions.get(edit);
  if (pending) return pending;
  const decision = showUnsavedFileDialog(edit).finally(() => {
    pendingDecisions.delete(edit);
  });
  pendingDecisions.set(edit, decision);
  return decision;
}

function showUnsavedFileDialog(edit: FileEditState): Promise<boolean> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay file-unsaved-overlay';
    const titleId = 'file-unsaved-title';
    overlay.innerHTML = `
      <div class="modal dialog-modal" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
        <div class="modal-content dialog-content">
          <div class="modal-header"><h3 id="${titleId}">${escapeHtml(t('fileViewer.unsavedTitle'))}</h3></div>
          <div class="modal-body">
            <p class="dialog-message">${escapeHtml(t('fileViewer.unsavedMessage'))}</p>
            <p class="file-unsaved-path">${escapeHtml(edit.path)}</p>
            <p class="file-unsaved-error" role="alert" hidden></p>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary" data-file-decision="cancel">${escapeHtml(t('dialog.cancel'))}</button>
            <button class="btn-danger" data-file-decision="discard">${escapeHtml(t('fileViewer.discard'))}</button>
            <button class="btn-primary" data-file-decision="save">${escapeHtml(t('fileViewer.save'))}</button>
          </div>
        </div>
      </div>`;
    let settled = false;
    let busy = false;
    let releaseBack: (() => void) | null = null;
    const buttons = Array.from(overlay.querySelectorAll<HTMLButtonElement>('button'));
    const error = overlay.querySelector<HTMLElement>('.file-unsaved-error');
    const close = (accepted: boolean): void => {
      if (settled || busy) return;
      settled = true;
      overlay.removeEventListener('keydown', onKey);
      releaseBack?.();
      overlay.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve(accepted);
    };
    const onKey = (event: KeyboardEvent): void => {
      // A decision dialog must never deliver Enter/Escape to the file or terminal.
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        close(false);
      } else if (event.key === 'Tab') {
        const available = buttons.filter((button) => !button.disabled);
        const index = available.indexOf(document.activeElement as HTMLButtonElement);
        if (available.length) {
          event.preventDefault();
          const next = (index + (event.shiftKey ? -1 : 1) + available.length) % available.length;
          available[next]?.focus();
        }
      }
    };
    overlay.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element) || busy) return;
      const action = target.closest<HTMLElement>('[data-file-decision]')?.dataset.fileDecision;
      if (action === 'cancel' || target === overlay) close(false);
      else if (action === 'discard') {
        edit.discard();
        close(true);
      } else if (action === 'save') {
        busy = true;
        buttons.forEach((button) => {
          button.disabled = true;
        });
        if (error) error.hidden = true;
        void edit
          .save()
          .then((saved) => {
            busy = false;
            if (saved) close(true);
            else if (error) {
              error.textContent = t('fileViewer.editedWhileSaving');
              error.hidden = false;
            }
          })
          .catch((reason: unknown) => {
            busy = false;
            if (error) {
              error.textContent =
                reason instanceof Error ? reason.message : t('fileViewer.saveFailed');
              error.hidden = false;
            }
          })
          .finally(() => {
            if (!settled) {
              buttons.forEach((button) => {
                button.disabled = false;
              });
              buttons.find((button) => button.dataset.fileDecision === 'save')?.focus();
            }
          });
      }
    });
    document.body.appendChild(overlay);
    releaseBack = registerBackButtonLayer(() => {
      close(false);
    });
    buttons[0]?.focus();
  });
}
