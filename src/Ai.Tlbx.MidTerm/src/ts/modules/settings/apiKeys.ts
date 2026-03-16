import type { ApiKeyInfoResponse, CreateApiKeyResponse } from '../../api/types';
import { createApiKey, deleteApiKey, getApiKeys } from '../../api/client';
import { showAlert, showConfirm } from '../../utils/dialog';
import { escapeHtml } from '../../utils/dom';
import { t } from '../i18n';
import { createLogger } from '../logging';

const log = createLogger('settings-api-keys');

let apiKeyControlsBound = false;

export function bindApiKeyControls(): void {
  if (apiKeyControlsBound) {
    return;
  }

  const createButton = document.getElementById('btn-create-api-key') as HTMLButtonElement | null;
  const nameInput = document.getElementById('api-key-name') as HTMLInputElement | null;
  const listContainer = document.getElementById('settings-api-key-list');
  if (!createButton || !nameInput || !listContainer) {
    return;
  }

  apiKeyControlsBound = true;

  createButton.addEventListener('click', () => {
    void handleCreateApiKey(createButton, nameInput);
  });

  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleCreateApiKey(createButton, nameInput);
    }
  });

  listContainer.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const deleteButton = target?.closest<HTMLButtonElement>('[data-role="delete-api-key"]');
    if (!deleteButton) {
      return;
    }

    const id = deleteButton.dataset.id ?? '';
    const name = deleteButton.dataset.name ?? '';
    void handleDeleteApiKey(id, name);
  });
}

export async function fetchApiKeys(): Promise<void> {
  const listContainer = document.getElementById('settings-api-key-list');
  if (!listContainer) {
    return;
  }

  renderLoading(listContainer);

  try {
    const { data, response } = await getApiKeys();
    if (!response.ok || !data) {
      throw new Error(await response.text());
    }

    renderApiKeys(listContainer, data.apiKeys);
  } catch (error) {
    log.warn(() => `Failed to load API keys: ${String(error)}`);
    listContainer.innerHTML = `<div class="api-key-empty">${escapeHtml(t('settings.security.apiKeyLoadFailed'))}</div>`;
  }
}

function renderLoading(listContainer: HTMLElement): void {
  listContainer.innerHTML = `<div class="api-key-empty">${escapeHtml(t('settings.general.loading'))}</div>`;
}

function renderApiKeys(listContainer: HTMLElement, apiKeys: ApiKeyInfoResponse[]): void {
  if (apiKeys.length === 0) {
    listContainer.innerHTML = `<div class="api-key-empty">${escapeHtml(t('settings.security.apiKeyListEmpty'))}</div>`;
    return;
  }

  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  listContainer.innerHTML = apiKeys
    .map((apiKey) => {
      const createdAt = formatTimestamp(apiKey.createdAtUtc, dateFormatter);
      const lastUsed = apiKey.lastUsedAtUtc
        ? formatTimestamp(apiKey.lastUsedAtUtc, dateFormatter)
        : t('settings.security.apiKeyNeverUsed');

      return `
        <div class="api-key-item">
          <div class="api-key-item-main">
            <div class="api-key-item-header">
              <span class="api-key-item-name">${escapeHtml(apiKey.name)}</span>
              <code class="path-value api-key-preview">${escapeHtml(apiKey.preview)}</code>
            </div>
            <div class="api-key-item-meta">
              <span><strong>${escapeHtml(t('settings.security.apiKeyCreatedAt'))}:</strong> ${escapeHtml(createdAt)}</span>
              <span><strong>${escapeHtml(t('settings.security.apiKeyLastUsed'))}:</strong> ${escapeHtml(lastUsed)}</span>
            </div>
          </div>
          <div class="api-key-item-actions">
            <button
              class="btn-danger"
              data-role="delete-api-key"
              data-id="${escapeHtml(apiKey.id)}"
              data-name="${escapeHtml(apiKey.name)}"
            >
              ${escapeHtml(t('settings.security.apiKeyRevoke'))}
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

async function handleCreateApiKey(
  createButton: HTMLButtonElement,
  nameInput: HTMLInputElement,
): Promise<void> {
  const name = nameInput.value.trim();
  if (!name) {
    await showAlert(t('settings.security.apiKeyNameRequired'), {
      title: t('settings.security.apiKeys'),
    });
    nameInput.focus();
    return;
  }

  const originalText = createButton.textContent;
  createButton.disabled = true;
  createButton.textContent = t('settings.security.apiKeyCreating');

  try {
    const { data, response } = await createApiKey(name);
    if (!response.ok || !data) {
      throw new Error(await response.text());
    }

    await showCreatedKey(data);
    nameInput.value = '';
    await fetchApiKeys();
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : t('settings.security.apiKeyCreateFailed');
    await showAlert(message, { title: t('settings.security.apiKeys') });
  } finally {
    createButton.disabled = false;
    createButton.textContent = originalText;
  }
}

async function showCreatedKey(response: CreateApiKeyResponse): Promise<void> {
  let copied = false;

  try {
    await navigator.clipboard.writeText(response.token);
    copied = true;
  } catch (error) {
    log.info(() => `Clipboard write for API key failed: ${String(error)}`);
  }

  const suffix = copied
    ? t('settings.security.apiKeyCopied')
    : t('settings.security.apiKeyCopyFailed');

  await showAlert(`${t('settings.security.apiKeyCreatedHint')} ${response.token} ${suffix}`, {
    title: t('settings.security.apiKeyCreatedTitle'),
  });
}

async function handleDeleteApiKey(id: string, name: string): Promise<void> {
  const confirmed = await showConfirm(
    t('settings.security.apiKeyRevokeConfirm').replace('{name}', name || id),
    {
      title: t('settings.security.apiKeys'),
      confirmLabel: t('settings.security.apiKeyRevoke'),
      danger: true,
    },
  );

  if (!confirmed) {
    return;
  }

  try {
    const { response } = await deleteApiKey(id);
    if (!response.ok && response.status !== 404) {
      throw new Error(await response.text());
    }

    await fetchApiKeys();
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : t('settings.security.apiKeyDeleteFailed');
    await showAlert(message, { title: t('settings.security.apiKeys') });
  }
}

function formatTimestamp(value: string, formatter: Intl.DateTimeFormat): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return formatter.format(parsed);
}
