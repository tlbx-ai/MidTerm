import { escapeHtml } from '../../utils/dom';
import { t } from '../i18n';

export type LauncherProvider = 'terminal' | 'codex' | 'claude';

export interface SessionLauncherSelection {
  provider: LauncherProvider;
  workingDirectory: string;
}

interface LauncherDirectoryEntry {
  name: string;
  fullPath: string;
  isRoot: boolean;
}

interface LauncherDirectoryListResponse {
  path: string;
  parentPath: string | null;
  entries: LauncherDirectoryEntry[];
}

interface LauncherPathResponse {
  path: string;
}

interface LauncherState {
  provider: LauncherProvider | null;
  homePath: string;
  currentPath: string;
  parentPath: string | null;
  selectedPath: string;
  roots: LauncherDirectoryEntry[];
  entries: LauncherDirectoryEntry[];
  loading: boolean;
  error: string | null;
  requestToken: number;
}

export async function openSessionLauncher(): Promise<SessionLauncherSelection | null> {
  const [home, roots] = await Promise.all([fetchHomePath(), fetchLauncherRoots()]);

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay session-launcher-overlay';

    overlay.innerHTML = `
      <div class="modal session-launcher-modal" role="dialog" aria-modal="true" aria-labelledby="session-launcher-title">
        <div class="modal-content session-launcher-content">
          <div class="modal-header">
            <div>
              <div class="session-launcher-kicker">${escapeHtml(t('sidebar.newTerminal'))}</div>
              <h3 id="session-launcher-title">${escapeHtml(t('sessionLauncher.title'))}</h3>
            </div>
            <button class="modal-close" type="button" data-role="cancel" aria-label="${escapeHtml(t('dialog.cancel'))}">&times;</button>
          </div>
          <div class="modal-body session-launcher-body">
            <div class="session-launcher-providers" data-role="providers"></div>
            <div class="session-launcher-browser hidden" data-role="browser">
              <div class="session-launcher-toolbar">
                <button type="button" class="btn-secondary" data-action="home">${escapeHtml(t('sessionLauncher.home'))}</button>
                <button type="button" class="btn-secondary" data-action="up">${escapeHtml(t('sessionLauncher.up'))}</button>
                <div class="session-launcher-path" data-role="path"></div>
              </div>
              <div class="session-launcher-roots" data-role="roots"></div>
              <div class="session-launcher-selection">
                <div class="session-launcher-selection-label">${escapeHtml(t('sessionLauncher.startDir'))}</div>
                <div class="session-launcher-selection-value" data-role="selection"></div>
              </div>
              <div class="session-launcher-status hidden" data-role="status"></div>
              <div class="session-launcher-list" data-role="list"></div>
            </div>
          </div>
          <div class="modal-footer session-launcher-footer">
            <button type="button" class="btn-secondary" data-role="cancel">${escapeHtml(t('dialog.cancel'))}</button>
            <button type="button" class="btn-primary" data-role="start" disabled>${escapeHtml(t('sessionLauncher.chooseProvider'))}</button>
          </div>
        </div>
      </div>
    `;

    const state: LauncherState = {
      provider: null,
      homePath: home.path,
      currentPath: home.path,
      parentPath: null,
      selectedPath: home.path,
      roots: roots.entries,
      entries: [],
      loading: false,
      error: null,
      requestToken: 0,
    };

    const providersEl = overlay.querySelector<HTMLElement>('[data-role="providers"]');
    const browserEl = overlay.querySelector<HTMLElement>('[data-role="browser"]');
    const pathEl = overlay.querySelector<HTMLElement>('[data-role="path"]');
    const rootsEl = overlay.querySelector<HTMLElement>('[data-role="roots"]');
    const selectionEl = overlay.querySelector<HTMLElement>('[data-role="selection"]');
    const statusEl = overlay.querySelector<HTMLElement>('[data-role="status"]');
    const listEl = overlay.querySelector<HTMLElement>('[data-role="list"]');
    const startBtn = overlay.querySelector<HTMLButtonElement>('[data-role="start"]');
    const cancelButtons = overlay.querySelectorAll<HTMLElement>('[data-role="cancel"]');

    if (
      !providersEl ||
      !browserEl ||
      !pathEl ||
      !rootsEl ||
      !selectionEl ||
      !statusEl ||
      !listEl ||
      !startBtn
    ) {
      overlay.remove();
      resolve(null);
      return;
    }

    const safeProvidersEl = providersEl;
    const safeBrowserEl = browserEl;
    const safePathEl = pathEl;
    const safeRootsEl = rootsEl;
    const safeSelectionEl = selectionEl;
    const safeStatusEl = statusEl;
    const safeListEl = listEl;
    const safeStartBtn = startBtn;

    function close(result: SessionLauncherSelection | null): void {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      resolve(result);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
      } else if (event.key === 'Enter' && !safeStartBtn.disabled) {
        event.preventDefault();
        if (!state.provider) {
          return;
        }

        close({
          provider: state.provider,
          workingDirectory: state.selectedPath,
        });
      }
    }

    function renderProviders(): void {
      safeProvidersEl.innerHTML = getProviders()
        .map((definition) => {
          const active = definition.provider === state.provider ? ' active' : '';
          const badge = definition.beta
            ? `<span class="feature-beta-badge">${escapeHtml(t('common.beta'))}</span>`
            : '';
          return `
            <button type="button" class="session-launcher-provider${active}" data-provider="${definition.provider}">
              <span class="session-launcher-provider-heading">
                <span class="session-launcher-provider-title">${escapeHtml(definition.title)}</span>
                ${badge}
              </span>
              <span class="session-launcher-provider-description">${escapeHtml(definition.description)}</span>
            </button>
          `;
        })
        .join('');
    }

    function renderRoots(): void {
      safeRootsEl.innerHTML = state.roots
        .map((entry) => {
          const active = entry.fullPath === state.currentPath ? ' active' : '';
          return `
            <button type="button" class="session-launcher-root${active}" data-root-path="${escapeHtml(entry.fullPath)}">
              ${escapeHtml(entry.name)}
            </button>
          `;
        })
        .join('');
    }

    function renderStatus(): void {
      const shouldShow = state.loading || Boolean(state.error);
      safeStatusEl.classList.toggle('hidden', !shouldShow);
      safeStatusEl.classList.toggle('error', Boolean(state.error));
      safeStatusEl.textContent = state.loading ? t('sessionLauncher.loading') : (state.error ?? '');
    }

    function renderList(): void {
      if (state.loading) {
        safeListEl.innerHTML = '';
        return;
      }

      if (state.entries.length === 0) {
        safeListEl.innerHTML = `<div class="session-launcher-empty">${escapeHtml(t('sessionLauncher.empty'))}</div>`;
        return;
      }

      safeListEl.innerHTML = state.entries
        .map((entry) => {
          const selected = entry.fullPath === state.selectedPath ? ' selected' : '';
          return `
            <div class="session-launcher-row${selected}" data-entry-path="${escapeHtml(entry.fullPath)}">
              <button type="button" class="session-launcher-row-main" data-select-path="${escapeHtml(entry.fullPath)}">
                <span class="session-launcher-row-icon">&#xea83;</span>
                <span class="session-launcher-row-label">${escapeHtml(entry.name)}</span>
              </button>
              <button type="button" class="session-launcher-row-open" data-open-path="${escapeHtml(entry.fullPath)}">
                ${escapeHtml(t('sessionLauncher.openFolder'))}
              </button>
            </div>
          `;
        })
        .join('');
    }

    function render(): void {
      renderProviders();
      renderRoots();
      renderStatus();
      renderList();

      safeBrowserEl.classList.toggle('hidden', state.provider === null);
      safePathEl.textContent = state.currentPath;
      safeSelectionEl.textContent = state.selectedPath;
      safeStartBtn.disabled = state.provider === null || state.loading || !state.selectedPath;
      safeStartBtn.textContent =
        state.provider === null
          ? t('sessionLauncher.chooseProvider')
          : state.provider === 'terminal'
            ? t('sessionLauncher.startTerminal')
            : state.provider === 'codex'
              ? t('sessionLauncher.startCodex')
              : t('sessionLauncher.startClaude');
    }

    async function loadDirectory(path: string): Promise<void> {
      const requestToken = ++state.requestToken;
      state.loading = true;
      state.error = null;
      render();

      try {
        const response = await fetchDirectories(path);
        if (requestToken !== state.requestToken) {
          return;
        }

        state.currentPath = response.path;
        state.parentPath = response.parentPath;
        state.selectedPath = response.path;
        state.entries = response.entries;
      } catch (error) {
        if (requestToken !== state.requestToken) {
          return;
        }

        state.error = error instanceof Error ? error.message : String(error);
      } finally {
        if (requestToken === state.requestToken) {
          state.loading = false;
          render();
        }
      }
    }

    render();
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown);
    overlay.querySelector<HTMLButtonElement>('[data-provider="terminal"]')?.focus();
    void loadDirectory(state.homePath);

    safeProvidersEl.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-provider]');
      if (!target) {
        return;
      }

      state.provider = target.dataset.provider as LauncherProvider;
      render();
    });

    safeRootsEl.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-root-path]');
      const rootPath = target?.dataset.rootPath;
      if (!rootPath) {
        return;
      }

      void loadDirectory(rootPath);
    });

    safeListEl.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const selectPath = target?.closest<HTMLElement>('[data-select-path]')?.dataset.selectPath;
      if (selectPath) {
        state.selectedPath = selectPath;
        render();
        return;
      }

      const openPath = target?.closest<HTMLElement>('[data-open-path]')?.dataset.openPath;
      if (openPath) {
        void loadDirectory(openPath);
      }
    });

    safeListEl.addEventListener('dblclick', (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        '[data-entry-path]',
      );
      const entryPath = target?.dataset.entryPath;
      if (entryPath) {
        void loadDirectory(entryPath);
      }
    });

    overlay.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (target === overlay) {
        close(null);
        return;
      }

      if (target?.closest('[data-role="cancel"]')) {
        close(null);
        return;
      }

      const action = target?.closest<HTMLElement>('[data-action]')?.dataset.action;
      if (action === 'home') {
        void loadDirectory(state.homePath);
      } else if (action === 'up' && state.parentPath) {
        void loadDirectory(state.parentPath);
      } else if (target?.closest('[data-role="start"]') && state.provider && state.selectedPath) {
        close({
          provider: state.provider,
          workingDirectory: state.selectedPath,
        });
      }
    });

    cancelButtons.forEach((button) => {
      button.setAttribute('type', 'button');
    });
  });
}

async function fetchHomePath(): Promise<LauncherPathResponse> {
  const response = await fetch('/api/files/picker/home');
  if (!response.ok) {
    throw new Error(t('sessionLauncher.loadFailed'));
  }

  return (await response.json()) as LauncherPathResponse;
}

function getProviders(): ReadonlyArray<{
  provider: LauncherProvider;
  title: string;
  description: string;
  beta?: boolean;
}> {
  return [
    {
      provider: 'terminal',
      title: t('sessionLauncher.terminalTitle'),
      description: t('sessionLauncher.terminalDescription'),
    },
    {
      provider: 'codex',
      title: t('sessionLauncher.codexTitle'),
      description: t('sessionLauncher.codexDescription'),
      beta: true,
    },
    {
      provider: 'claude',
      title: t('sessionLauncher.claudeTitle'),
      description: t('sessionLauncher.claudeDescription'),
      beta: true,
    },
  ];
}

async function fetchLauncherRoots(): Promise<LauncherDirectoryListResponse> {
  const response = await fetch('/api/files/picker/roots');
  if (!response.ok) {
    throw new Error(t('sessionLauncher.loadFailed'));
  }

  return (await response.json()) as LauncherDirectoryListResponse;
}

async function fetchDirectories(path: string): Promise<LauncherDirectoryListResponse> {
  const response = await fetch(`/api/files/picker/directories?path=${encodeURIComponent(path)}`);
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as LauncherDirectoryListResponse;
}
