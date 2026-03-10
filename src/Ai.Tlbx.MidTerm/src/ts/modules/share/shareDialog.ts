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
    <div class="modal dialog-modal">
      <div class="modal-content dialog-content share-dialog-modal">
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
          <div class="share-dialog-result">
            <label for="share-link-output">${escapeHtml(t('share.dialog.link'))}</label>
            <input id="share-link-output" class="share-link-output" type="text" readonly />
            <p class="share-dialog-expiry"></p>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" data-role="cancel">${escapeHtml(t('dialog.cancel'))}</button>
          <button class="btn-primary" data-role="create">${escapeHtml(t('share.dialog.creating'))}</button>
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

  let currentShareUrl = '';
  let currentMode: ShareMode | null = null;
  let requestGeneration = 0;

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

  const getSelectedMode = (): ShareMode => {
    const selected = overlay.querySelector<HTMLInputElement>('input[name="share-mode"]:checked');
    return (selected?.value as ShareMode | undefined) ?? 'FullControl';
  };

  const copyCurrentLink = async (): Promise<void> => {
    if (!currentShareUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(currentShareUrl);
      createBtn.textContent = t('share.dialog.copied');
    } catch (clipboardError) {
      log.warn(() => `Share link copy failed: ${String(clipboardError)}`);
      outputEl.focus();
      outputEl.select();
    }
  };

  const loadShareLink = async (mode: ShareMode): Promise<void> => {
    const requestId = ++requestGeneration;
    currentShareUrl = '';
    currentMode = mode;
    resultEl.classList.remove('hidden');
    outputEl.value = '';
    outputEl.placeholder = t('share.dialog.creating');
    expiryEl.textContent = '';
    createBtn.disabled = true;
    createBtn.textContent = t('share.dialog.creating');

    try {
      const response = await createShareLink({ sessionId, mode });
      if (requestId !== requestGeneration) {
        return;
      }

      currentShareUrl = response.shareUrl;
      outputEl.value = response.shareUrl;
      expiryEl.textContent =
        t('share.dialog.expiresAt') + ': ' + new Date(response.expiresAtUtc).toLocaleString();
      createBtn.textContent = t('trust.copy');
    } catch (error) {
      if (requestId !== requestGeneration) {
        return;
      }

      log.error(() => `Failed to create share link: ${String(error)}`);
      currentShareUrl = '';
      outputEl.placeholder = t('share.failedToGenerate');
      createBtn.textContent = t('share.failedToGenerate');
    } finally {
      if (requestId === requestGeneration) {
        createBtn.disabled = false;
      }
    }
  };

  createBtn.addEventListener('click', () => {
    const selectedMode = getSelectedMode();
    if (currentShareUrl !== '' && currentMode === selectedMode) {
      void copyCurrentLink();
      return;
    }

    void loadShareLink(selectedMode);
  });
  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);

  const modeOptions = overlay.querySelectorAll<HTMLInputElement>('input[name="share-mode"]');
  modeOptions.forEach((option) => {
    option.addEventListener('change', () => {
      void loadShareLink(getSelectedMode());
    });
  });

  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  cancelBtn.focus();
  void loadShareLink(getSelectedMode());
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
