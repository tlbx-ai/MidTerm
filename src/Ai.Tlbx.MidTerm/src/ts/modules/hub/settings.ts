import { t } from '../i18n';
import { showAlert, showConfirm } from '../../utils/dialog';
import {
  applyHubUpdates,
  clearHubMachinePin,
  createHubMachine,
  createRemoteSession,
  deleteHubMachine,
  pinHubMachine,
  refreshHubMachine,
} from './api';
import { getHubMachines, refreshHubState } from './runtime';

function getValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? '';
}

function setStatus(message: string): void {
  const status = document.getElementById('hub-settings-status');
  if (status) {
    status.textContent = message;
  }
}

function renderHubMachines(): void {
  const list = document.getElementById('hub-machine-list');
  if (!list) return;

  list.replaceChildren();
  for (const machine of getHubMachines()) {
    const article = document.createElement('article');
    article.className = 'hub-machine-card';
    article.dataset.hubMachineId = machine.machine.id;
    article.innerHTML = `
      <div class="hub-machine-card-header">
        <div>
          <h3>${machine.machine.name}</h3>
          <div class="hub-machine-url">${machine.machine.baseUrl}</div>
        </div>
        <span class="hub-machine-status hub-status-${machine.status}">${machine.status}</span>
      </div>
      <div class="hub-machine-grid">
        <div><label>${t('settings.hub.fingerprint')}</label><code>${machine.machine.lastFingerprint ?? '-'}</code></div>
        <div><label>${t('settings.hub.pinnedFingerprint')}</label><code>${machine.machine.pinnedFingerprint ?? '-'}</code></div>
        <div><label>${t('settings.hub.remoteSessions')}</label><span>${String(machine.sessions.length)}</span></div>
        <div><label>${t('settings.hub.remoteUpdate')}</label><span>${machine.updateAvailable ? (machine.latestVersion ?? t('settings.hub.updateAvailable')) : t('settings.hub.noUpdate')}</span></div>
      </div>
      <div class="hub-machine-error">${machine.error ?? ''}</div>
      <div class="hub-machine-actions">
        <button type="button" class="btn-secondary" data-action="refresh">${t('settings.hub.refresh')}</button>
        <button type="button" class="btn-secondary" data-action="pin">${t('settings.hub.pin')}</button>
        <button type="button" class="btn-secondary" data-action="clear-pin">${t('settings.hub.clearPin')}</button>
        <button type="button" class="btn-secondary" data-action="create-session">${t('settings.hub.createSession')}</button>
        <button type="button" class="btn-danger" data-action="delete">${t('settings.hub.removeMachine')}</button>
      </div>
    `;

    article
      .querySelector<HTMLElement>('.hub-machine-error')
      ?.classList.toggle('hidden', !machine.error);
    article.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        void handleMachineAction(machine.machine.id, button.dataset.action ?? '');
      });
    });

    list.appendChild(article);
  }
}

async function handleMachineAction(machineId: string, action: string): Promise<void> {
  try {
    if (action === 'refresh') {
      await refreshHubMachine(machineId);
      await refreshHubState();
      setStatus(t('settings.hub.refreshed'));
      return;
    }

    if (action === 'pin') {
      await pinHubMachine(machineId);
      await refreshHubState();
      setStatus(t('settings.hub.pinSaved'));
      return;
    }

    if (action === 'clear-pin') {
      await clearHubMachinePin(machineId);
      await refreshHubState();
      setStatus(t('settings.hub.pinCleared'));
      return;
    }

    if (action === 'create-session') {
      await createRemoteSession(machineId);
      await refreshHubState();
      setStatus(t('settings.hub.remoteSessionCreated'));
      return;
    }

    if (action === 'delete') {
      const confirmed = await showConfirm(t('settings.hub.removeMachineConfirm'), {
        title: t('settings.hub.removeMachine'),
        confirmLabel: t('settings.hub.removeMachine'),
        danger: true,
      });
      if (!confirmed) return;
      await deleteHubMachine(machineId);
      await refreshHubState();
      setStatus(t('settings.hub.machineRemoved'));
    }
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: t('settings.hub.title'),
    });
  }
}

export function bindHubSettings(): void {
  const addButton = document.getElementById('btn-hub-add-machine');
  const updateButton = document.getElementById('btn-hub-control-updates');
  if (!addButton || !updateButton) {
    return;
  }

  addButton.addEventListener('click', () => {
    void (async () => {
      const name = getValue('hub-machine-name');
      const baseUrl = getValue('hub-machine-url');
      const apiKey = getValue('hub-machine-api-key');
      const password = getValue('hub-machine-password');
      try {
        await createHubMachine({
          name,
          baseUrl,
          enabled: true,
          apiKey: apiKey || null,
          password: password || null,
        });
        const nameInput = document.getElementById('hub-machine-name') as HTMLInputElement | null;
        const urlInput = document.getElementById('hub-machine-url') as HTMLInputElement | null;
        const apiKeyInput = document.getElementById(
          'hub-machine-api-key',
        ) as HTMLInputElement | null;
        const passwordInput = document.getElementById(
          'hub-machine-password',
        ) as HTMLInputElement | null;
        if (nameInput) nameInput.value = '';
        if (urlInput) urlInput.value = '';
        if (apiKeyInput) apiKeyInput.value = '';
        if (passwordInput) passwordInput.value = '';
        await refreshHubState();
        setStatus(t('settings.hub.machineSaved'));
      } catch (error) {
        await showAlert(error instanceof Error ? error.message : String(error), {
          title: t('settings.hub.title'),
        });
      }
    })();
  });

  updateButton.addEventListener('click', () => {
    void (async () => {
      try {
        const result = await applyHubUpdates({
          machineIds: getHubMachines().map((machine) => machine.machine.id),
        });
        const lines = result.results.map(
          (item) => `${item.machineName}: ${item.status} - ${item.message}`,
        );
        await showAlert(lines.join('\n') || t('settings.hub.noMachinesConfigured'), {
          title: t('settings.hub.controlUpdates'),
        });
        await refreshHubState();
      } catch (error) {
        await showAlert(error instanceof Error ? error.message : String(error), {
          title: t('settings.hub.controlUpdates'),
        });
      }
    })();
  });

  void refreshHubState()
    .then(renderHubMachines)
    .catch(() => {});
}

export function renderHubSettings(): void {
  renderHubMachines();
}
