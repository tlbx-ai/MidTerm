/**
 * Share Dialog Module
 *
 * Creates scoped one-hour share links for the current terminal session.
 */

import { createShareLink, type CreateShareLinkRequest } from '../../api/client';
import { getSession } from '../../stores';
import { t } from '../i18n';
import { createLogger } from '../logging';
import { setShareClickHandler } from '../sessionTabs';

const log = createLogger('shareDialog');

type ShareMode = CreateShareLinkRequest['mode'];

export function initSessionShareButton(): void {
  setShareClickHandler((sessionId) => {
    openShareDialog(sessionId);
  });
}

function openShareDialog(sessionId: string): void {
  const session = getSession(sessionId);
  const sessionName = session?.name || session?.terminalTitle || sessionId;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal dialog-modal share-dialog-modal">
      <div class="modal-content dialog-content">
        <div class="modal-header">
          <h3>${escapeHtml(t('share.dialog.title'))}</h3>
          <button class="modal-close" data-role="close">&times;</button>
        </div>
        <div class="modal-body share-dialog-body">
          <p class="dialog-message">${escapeHtml(t('share.dialog.sessionPrefix'))}: ${escapeHtml(sessionName)}</p>
          <label class="share-dialog-option">
            <input type="radio" name="share-mode" value="FullControl" checked />
            <span>${escapeHtml(t('share.dialog.fullControl'))}</span>
          </label>
          <label class="share-dialog-option">
            <input type="radio" name="share-mode" value="ViewOnly" />
            <span>${escapeHtml(t('share.dialog.viewOnly'))}</span>
          </label>
          <p class="share-dialog-hint">${escapeHtml(t('share.dialog.hint'))}</p>
          <div class="share-dialog-result hidden">
            <label for="share-link-output">${escapeHtml(t('share.dialog.link'))}</label>
            <input id="share-link-output" class="share-link-output" type="text" readonly />
            <p class="share-dialog-expiry"></p>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" data-role="cancel">${escapeHtml(t('dialog.cancel'))}</button>
          <button class="btn-primary" data-role="create">${escapeHtml(t('share.dialog.create'))}</button>
        </div>
      </div>
    </div>
  `;

  const createBtn = overlay.querySelector<HTMLButtonElement>('[data-role="create"]');
  const cancelBtn = overlay.querySelector<HTMLButtonElement>('[data-role="cancel"]');
  const closeBtn = overlay.querySelector<HTMLButtonElement>('[data-role="close"]');
  const resultEl = overlay.querySelector<HTMLElement>('.share-dialog-result');
  const outputEl = overlay.querySelector<HTMLInputElement>('#share-link-output');
  const expiryEl = overlay.querySelector<HTMLElement>('.share-dialog-expiry');

  if (!createBtn || !cancelBtn || !closeBtn || !resultEl || !outputEl || !expiryEl) {
    overlay.remove();
    return;
  }

  function close(): void {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
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
    if (role === 'cancel' || role === 'close') {
      close();
    }
  });

  const handleCreateClick = async (): Promise<void> => {
    const selected = overlay.querySelector<HTMLInputElement>('input[name="share-mode"]:checked');
    const mode = (selected?.value as ShareMode | undefined) ?? 'FullControl';

    createBtn.disabled = true;
    createBtn.textContent = t('share.dialog.creating');

    try {
      const response = await createShareLink({ sessionId, mode });
      outputEl.value = response.shareUrl;
      resultEl.classList.remove('hidden');
      expiryEl.textContent =
        t('share.dialog.expiresAt') + ': ' + new Date(response.expiresAtUtc).toLocaleString();
      createBtn.textContent = t('share.dialog.create');

      try {
        await navigator.clipboard.writeText(response.shareUrl);
        createBtn.textContent = t('share.dialog.copied');
      } catch (clipboardError) {
        log.warn(() => `Share link created but clipboard copy failed: ${String(clipboardError)}`);
        outputEl.focus();
        outputEl.select();
      }
    } catch (error) {
      log.error(() => `Failed to create share link: ${String(error)}`);
      createBtn.textContent = t('share.failedToGenerate');
    } finally {
      createBtn.disabled = false;
    }
  };

  createBtn.addEventListener('click', () => {
    void handleCreateClick();
  });
  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);

  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  createBtn.focus();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
