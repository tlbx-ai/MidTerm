import { t } from '../i18n';
import { showAlert, showConfirm } from '../../utils/dialog';
import { escapeHtml } from '../../utils/dom';
import {
  applyHubUpdates,
  clearHubMachinePin,
  createHubMachine,
  createRemoteSession,
  deleteHubMachine,
  pinHubMachine,
  refreshHubMachine,
  updateHubMachine,
} from './api';
import { getHubMachines, refreshHubState } from './runtime';
import type { HubMachineState, HubMachineUpsertRequest } from './types';
import { registerBackButtonLayer } from '../navigation/backButtonGuard';

interface HubMachineDraft {
  machineId: string | null;
  baseUrl: string;
  apiKey?: string | null;
  password?: string | null;
}

let releaseBackButtonLayer: (() => void) | null = null;

function getInput(id: string): HTMLInputElement | null {
  return document.getElementById(id) as HTMLInputElement | null;
}

function getValue(id: string): string {
  return getInput(id)?.value.trim() ?? '';
}

function getMachineModal(): HTMLElement | null {
  return document.getElementById('hub-machine-modal');
}

function getMachineById(machineId: string): HubMachineState | undefined {
  return getHubMachines().find((machine) => machine.machine.id === machineId);
}

function setStatus(message: string): void {
  const status = document.getElementById('hub-settings-status');
  if (status) {
    status.textContent = message;
  }
}

function clearMachineModal(): void {
  const machineIdInput = getInput('hub-machine-id');
  const urlInput = getInput('hub-machine-url');
  const apiKeyInput = getInput('hub-machine-api-key');
  const passwordInput = getInput('hub-machine-password');

  if (machineIdInput) machineIdInput.value = '';
  if (urlInput) urlInput.value = '';
  if (apiKeyInput) apiKeyInput.value = '';
  if (passwordInput) passwordInput.value = '';
}

function setMachineModalTitle(machineId: string | null): void {
  const title = document.getElementById('hub-machine-modal-title');
  if (!title) {
    return;
  }

  title.textContent = machineId ? t('settings.hub.editHost') : t('settings.hub.addHost');
}

function openMachineModal(machineId?: string): void {
  const modal = getMachineModal();
  if (!modal) {
    return;
  }

  clearMachineModal();
  const machine = machineId ? getMachineById(machineId) : undefined;
  const machineIdInput = getInput('hub-machine-id');
  const urlInput = getInput('hub-machine-url');
  const apiKeyInput = getInput('hub-machine-api-key');
  const passwordInput = getInput('hub-machine-password');

  if (machine && machineIdInput && urlInput && apiKeyInput && passwordInput) {
    machineIdInput.value = machine.machine.id;
    urlInput.value = machine.machine.baseUrl;
    apiKeyInput.placeholder = machine.machine.hasApiKey
      ? t('settings.hub.apiKeyStoredPlaceholder')
      : t('settings.hub.apiKeyPlaceholder');
    passwordInput.placeholder = machine.machine.hasPassword
      ? t('settings.hub.passwordStoredPlaceholder')
      : t('settings.hub.passwordPlaceholder');
  } else {
    if (apiKeyInput) apiKeyInput.placeholder = t('settings.hub.apiKeyPlaceholder');
    if (passwordInput) passwordInput.placeholder = t('settings.hub.passwordPlaceholder');
  }

  setMachineModalTitle(machine?.machine.id ?? null);
  if (!releaseBackButtonLayer) {
    releaseBackButtonLayer = registerBackButtonLayer(closeMachineModal);
  }
  modal.classList.remove('hidden');
  getInput('hub-machine-url')?.focus();
}

function closeMachineModal(): void {
  releaseBackButtonLayer?.();
  releaseBackButtonLayer = null;

  const modal = getMachineModal();
  if (!modal) {
    return;
  }

  modal.classList.add('hidden');
  clearMachineModal();
}

function buildDraft(): HubMachineDraft {
  const machineId = getValue('hub-machine-id') || null;
  const machine = machineId ? getMachineById(machineId) : undefined;
  const apiKey = getValue('hub-machine-api-key');
  const password = getValue('hub-machine-password');

  const request: HubMachineDraft = {
    machineId,
    baseUrl: getValue('hub-machine-url'),
  };

  if (apiKey) {
    request.apiKey = apiKey;
  } else if (!machineId || !machine?.machine.hasApiKey) {
    request.apiKey = null;
  }

  if (password) {
    request.password = password;
  } else if (!machineId || !machine?.machine.hasPassword) {
    request.password = null;
  }

  return request;
}

function toUpsertRequest(draft: HubMachineDraft): HubMachineUpsertRequest {
  const machine = draft.machineId ? getMachineById(draft.machineId) : undefined;
  const request: HubMachineUpsertRequest = {
    name: machine?.machine.name ?? '',
    baseUrl: draft.baseUrl,
    enabled: machine?.machine.enabled ?? true,
  };

  if (draft.apiKey !== undefined) {
    request.apiKey = draft.apiKey;
  }

  if (draft.password !== undefined) {
    request.password = draft.password;
  }

  return request;
}

function renderHubMachines(): void {
  const list = document.getElementById('hub-machine-list');
  if (!list) return;

  list.replaceChildren();
  const machines = getHubMachines();
  if (machines.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hub-machine-empty';
    empty.textContent = t('settings.hub.noMachinesConfigured');
    list.appendChild(empty);
    return;
  }

  for (const machine of machines) {
    const article = document.createElement('article');
    article.className = `hub-machine-row hub-status-${machine.status}`;
    article.dataset.hubMachineId = machine.machine.id;

    const updateLabel = machine.updateAvailable
      ? (machine.latestVersion ?? t('settings.hub.updateAvailable'))
      : t('settings.hub.noUpdate');
    const authLabel = machine.machine.hasApiKey
      ? t('settings.hub.authApiKey')
      : machine.machine.hasPassword
        ? t('settings.hub.authPassword')
        : t('settings.hub.authOpen');
    const trustLabel = machine.requiresTrust
      ? t('settings.hub.trustRequired')
      : machine.machine.pinnedFingerprint
        ? t('settings.hub.trustPinned')
        : t('settings.hub.trustUnpinned');

    article.innerHTML = `
      <div class="hub-machine-main">
        <span class="hub-machine-indicator" aria-hidden="true"></span>
        <div class="hub-machine-identity">
          <span class="hub-machine-name">${escapeHtml(machine.machine.name)}</span>
          <span class="hub-machine-url">${escapeHtml(machine.machine.baseUrl)}</span>
        </div>
      </div>
      <div class="hub-machine-meta">
        <span class="hub-machine-pill"><strong>${escapeHtml(t('settings.hub.remoteSessions'))}</strong>${escapeHtml(String(machine.sessions.length))}</span>
        <span class="hub-machine-pill"><strong>${escapeHtml(t('settings.hub.remoteUpdate'))}</strong>${escapeHtml(updateLabel)}</span>
        <span class="hub-machine-pill"><strong>${escapeHtml(t('settings.hub.auth'))}</strong>${escapeHtml(authLabel)}</span>
        <span class="hub-machine-pill ${machine.requiresTrust ? 'hub-machine-pill-warning' : ''}"><strong>${escapeHtml(t('settings.hub.trust'))}</strong>${escapeHtml(trustLabel)}</span>
        ${machine.error ? `<span class="hub-machine-pill hub-machine-pill-danger">${escapeHtml(machine.error)}</span>` : ''}
      </div>
      <div class="hub-machine-actions">
        <button type="button" class="btn-primary" data-action="create-session">${escapeHtml(t('settings.hub.createSession'))}</button>
        <button type="button" class="btn-secondary" data-action="edit">${escapeHtml(t('settings.hub.edit'))}</button>
        <button type="button" class="btn-secondary" data-action="refresh">${escapeHtml(t('settings.hub.refresh'))}</button>
        <button type="button" class="btn-secondary" data-action="${machine.machine.pinnedFingerprint ? 'clear-pin' : 'pin'}">${escapeHtml(machine.machine.pinnedFingerprint ? t('settings.hub.clearPin') : t('settings.hub.pin'))}</button>
        <button type="button" class="btn-danger" data-action="delete">${escapeHtml(t('settings.hub.removeMachine'))}</button>
      </div>
    `;

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
    if (action === 'edit') {
      openMachineModal(machineId);
      return;
    }

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

async function saveMachineFromModal(): Promise<void> {
  const draft = buildDraft();
  const request = toUpsertRequest(draft);

  try {
    if (draft.machineId) {
      await updateHubMachine(draft.machineId, request);
    } else {
      await createHubMachine(request);
    }

    closeMachineModal();
    await refreshHubState();
    setStatus(t('settings.hub.machineSaved'));
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: t('settings.hub.title'),
    });
  }
}

export function bindHubSettings(): void {
  const openButton = document.getElementById('btn-hub-open-machine-modal');
  const form = document.getElementById('hub-machine-form') as HTMLFormElement | null;
  const cancelButton = document.getElementById('btn-cancel-hub-machine-modal');
  const closeButton = document.getElementById('btn-close-hub-machine-modal');
  const updateButton = document.getElementById('btn-hub-control-updates');
  const modal = getMachineModal();

  if (!openButton || !form || !cancelButton || !closeButton || !updateButton || !modal) {
    return;
  }

  openButton.addEventListener('click', () => {
    openMachineModal();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveMachineFromModal();
  });

  cancelButton.addEventListener('click', () => {
    closeMachineModal();
  });

  closeButton.addEventListener('click', () => {
    closeMachineModal();
  });

  modal.querySelector('.modal-backdrop')?.addEventListener('click', () => {
    closeMachineModal();
  });

  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMachineModal();
    }
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
  setMachineModalTitle(getValue('hub-machine-id') || null);
  renderHubMachines();
}
