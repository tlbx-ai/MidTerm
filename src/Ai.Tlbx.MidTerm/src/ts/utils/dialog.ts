/**
 * Dialog Utility
 *
 * Theme-aware modal dialogs to replace native browser confirm() and alert().
 * Reuses existing .modal CSS classes for consistent styling.
 */

import { t } from '../modules/i18n';
import { escapeHtml } from './dom';

interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface AlertOptions {
  title?: string;
  okLabel?: string;
}

/**
 * Show a themed confirmation dialog. Returns a promise that resolves to true (confirm) or false (cancel).
 */
export function showConfirm(message: string, options?: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const confirmClass = options?.danger ? 'btn-danger' : 'btn-primary';
    const titleText = options?.title ?? t('dialog.confirm');
    const confirmText = options?.confirmLabel ?? t('dialog.ok');
    const cancelText = options?.cancelLabel ?? t('dialog.cancel');

    overlay.innerHTML = `
      <div class="modal dialog-modal">
        <div class="modal-content dialog-content">
          <div class="modal-header">
            <h3>${escapeHtml(titleText)}</h3>
            <button class="modal-close" data-role="cancel">&times;</button>
          </div>
          <div class="modal-body">
            <p class="dialog-message">${escapeHtml(message)}</p>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary" data-role="cancel">${escapeHtml(cancelText)}</button>
            <button class="${confirmClass}" data-role="confirm">${escapeHtml(confirmText)}</button>
          </div>
        </div>
      </div>
    `;

    function close(result: boolean): void {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
      }
    }

    overlay.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target === overlay) {
        close(false);
        return;
      }
      const role = target.closest('[data-role]')?.getAttribute('data-role');
      if (role === 'confirm') close(true);
      else if (role === 'cancel') close(false);
    });

    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);

    // Focus the confirm button for keyboard accessibility
    const confirmBtn = overlay.querySelector<HTMLButtonElement>('[data-role="confirm"]');
    confirmBtn?.focus();
  });
}

/**
 * Show a themed alert dialog. Returns a promise that resolves when dismissed.
 */
export function showAlert(message: string, options?: AlertOptions): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const titleText = options?.title ?? t('dialog.info');
    const okText = options?.okLabel ?? t('dialog.ok');

    overlay.innerHTML = `
      <div class="modal dialog-modal">
        <div class="modal-content dialog-content">
          <div class="modal-header">
            <h3>${escapeHtml(titleText)}</h3>
            <button class="modal-close" data-role="ok">&times;</button>
          </div>
          <div class="modal-body">
            <p class="dialog-message">${escapeHtml(message)}</p>
          </div>
          <div class="modal-footer">
            <button class="btn-primary" data-role="ok">${escapeHtml(okText)}</button>
          </div>
        </div>
      </div>
    `;

    function close(): void {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve();
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        close();
      }
    }

    overlay.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target === overlay) {
        close();
        return;
      }
      const role = target.closest('[data-role]')?.getAttribute('data-role');
      if (role === 'ok') close();
    });

    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector<HTMLButtonElement>('[data-role="ok"]');
    okBtn?.focus();
  });
}
