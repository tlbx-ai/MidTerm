/**
 * Share Dialog Module
 *
 * Creates scoped one-hour share links for the current terminal session.
 */

import {
  createShareLink,
  getNetworks,
  getSharePacket,
  type CreateShareLinkRequest,
  type NetworkInterfaceDto,
} from '../../api/client';
import { getSession } from '../../stores';
import { t } from '../i18n';
import { createLogger } from '../logging';
import { setShareClickHandler } from '../sessionTabs';
import { getBootstrapData } from '../bootstrap';
import { registerBackButtonLayer } from '../navigation/backButtonGuard';

const log = createLogger('shareDialog');

type ShareMode = CreateShareLinkRequest['mode'];

interface ShareNetworkOption {
  name: string;
  host: string;
}

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
  let releaseBackButtonLayer: (() => void) | null = null;
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
          <div class="share-dialog-field">
            <label class="share-dialog-field-label" for="share-network-select">${escapeHtml(t('share.dialog.network'))}</label>
            <select id="share-network-select" class="share-network-select"></select>
          </div>
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
  const networkSelectEl = overlay.querySelector<HTMLSelectElement>('#share-network-select');

  if (
    !createBtn ||
    !cancelBtn ||
    !closeBtn ||
    !resultEl ||
    !outputEl ||
    !expiryEl ||
    !networkSelectEl
  ) {
    overlay.remove();
    return;
  }

  let currentShareUrl = '';
  let currentMode: ShareMode | null = null;
  let requestGeneration = 0;
  let networkOptions: ShareNetworkOption[] = [];

  function close(): void {
    document.removeEventListener('keydown', onKey);
    releaseBackButtonLayer?.();
    releaseBackButtonLayer = null;
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

  const getSelectedHost = (): string | null => {
    const selected = networkSelectEl.value.trim();
    return selected === '' ? null : selected;
  };

  const populateNetworkSelect = (options: ShareNetworkOption[], selectedHost: string): void => {
    const portSuffix = location.port ? `:${location.port}` : '';
    networkSelectEl.innerHTML = '';

    options.forEach((option) => {
      const el = document.createElement('option');
      el.value = option.host;
      el.textContent = `${option.name}  ${option.host}${portSuffix}`;
      if (option.host === selectedHost) {
        el.selected = true;
      }
      networkSelectEl.appendChild(el);
    });
  };

  const loadNetworkOptions = async (): Promise<void> => {
    const bootstrapNetworks = getBootstrapData()?.networks;
    const networkPromise = bootstrapNetworks
      ? Promise.resolve(bootstrapNetworks)
      : getNetworks().then(({ data, response }) => {
          if (!response.ok || !data) {
            throw new Error(`Failed to load networks: ${response.status}`);
          }
          return data;
        });

    const sharePacketPromise = getSharePacket().catch((error: unknown) => {
      log.warn(() => `Failed to load share packet: ${String(error)}`);
      return null;
    });

    const [networks, sharePacket] = await Promise.all([networkPromise, sharePacketPromise]);
    networkOptions = buildNetworkOptions(networks);

    const recommendedHost = getRecommendedHost(sharePacket?.data?.trustPageUrl ?? null);
    const selectedHost = chooseInitialHost(networkOptions, recommendedHost);
    populateNetworkSelect(networkOptions, selectedHost);
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
      const shareHost = getSelectedHost();
      const request: CreateShareLinkRequest = shareHost
        ? { sessionId, mode, shareHost }
        : { sessionId, mode };
      const response = await createShareLink(request);
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
  networkSelectEl.addEventListener('change', () => {
    void loadShareLink(getSelectedMode());
  });

  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  releaseBackButtonLayer = registerBackButtonLayer(close);
  cancelBtn.focus();
  createBtn.disabled = true;
  void loadNetworkOptions()
    .then(() => {
      if (networkOptions.length === 0) {
        throw new Error('No share networks available');
      }
      return loadShareLink(getSelectedMode());
    })
    .catch((error: unknown) => {
      log.error(() => `Failed to initialize share dialog: ${String(error)}`);
      outputEl.placeholder = t('share.failedToGenerate');
      createBtn.disabled = false;
      createBtn.textContent = t('share.failedToGenerate');
    });
}

function buildNetworkOptions(networks: NetworkInterfaceDto[]): ShareNetworkOption[] {
  const seenHosts = new Set<string>();
  const options: ShareNetworkOption[] = [];

  networks.forEach((network) => {
    const host = network.ip.trim();
    if (!host || seenHosts.has(host)) {
      return;
    }

    seenHosts.add(host);
    options.push({
      name: network.name,
      host,
    });
  });

  if (options.length === 0) {
    options.push({
      name: location.hostname,
      host: location.hostname,
    });
  }

  return options;
}

function chooseInitialHost(options: ShareNetworkOption[], recommendedHost: string | null): string {
  const currentHost = location.hostname;
  return (
    options.find((option) => option.host === recommendedHost)?.host ??
    options.find((option) => option.host === currentHost)?.host ??
    options.find((option) => option.host !== 'localhost')?.host ??
    options[0]?.host ??
    currentHost
  );
}

function getRecommendedHost(trustPageUrl: string | null): string | null {
  if (!trustPageUrl) {
    return null;
  }

  try {
    return new URL(trustPageUrl).hostname;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
