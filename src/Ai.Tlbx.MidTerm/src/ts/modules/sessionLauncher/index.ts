import { escapeHtml } from '../../utils/dom';
import { t } from '../i18n';
import { registerBackButtonLayer } from '../navigation/backButtonGuard';
import { getLaunchableHubMachines, refreshHubState, subscribeHubState } from '../hub/runtime';
import type { HubMachineState } from '../hub/types';

export type LauncherProvider = 'terminal' | 'codex' | 'claude';

const LOCAL_TARGET_ID = 'local';

export interface LocalSessionLauncherTarget {
  id: typeof LOCAL_TARGET_ID;
  kind: 'local';
}

export interface HubSessionLauncherTarget {
  id: string;
  kind: 'hub';
  machineId: string;
  machineName: string;
  baseUrl: string;
}

export type SessionLauncherTarget = LocalSessionLauncherTarget | HubSessionLauncherTarget;

export interface SessionLauncherSelection {
  provider: LauncherProvider;
  workingDirectory: string | null;
  target: SessionLauncherTarget;
}

interface VisibilityToggleTarget {
  hidden: boolean;
}

let activeLauncherPromise: Promise<SessionLauncherSelection | null> | null = null;

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
  homePath: string;
  startPath: string;
}

interface LauncherState {
  homePath: string;
  startPath: string;
  currentPath: string;
  pathDraft: string;
  pathHistory: string[];
  parentPath: string | null;
  roots: LauncherDirectoryEntry[];
  entries: LauncherDirectoryEntry[];
  loading: boolean;
  error: string | null;
  requestToken: number;
  targets: SessionLauncherTarget[];
  selectedTargetId: string;
  remotePathDrafts: Record<string, string>;
}

export function buildSessionLauncherTargets(
  machines: ReadonlyArray<HubMachineState>,
): SessionLauncherTarget[] {
  return [
    {
      id: LOCAL_TARGET_ID,
      kind: 'local',
    },
    ...machines.map((machine) => ({
      id: `hub:${machine.machine.id}`,
      kind: 'hub' as const,
      machineId: machine.machine.id,
      machineName: machine.machine.name,
      baseUrl: machine.machine.baseUrl,
    })),
  ];
}

export function isProviderSupportedOnTarget(
  provider: LauncherProvider,
  target: SessionLauncherTarget,
): boolean {
  return target.kind === 'local' || provider === 'terminal';
}

export function syncLocationPickerVisibility(
  target: SessionLauncherTarget,
  sections: {
    localBrowser: VisibilityToggleTarget;
    remoteBrowser: VisibilityToggleTarget;
  },
): boolean {
  const isLocalTarget = target.kind === 'local';
  sections.localBrowser.hidden = !isLocalTarget;
  sections.remoteBrowser.hidden = isLocalTarget;
  return isLocalTarget;
}

export async function openSessionLauncher(): Promise<SessionLauncherSelection | null> {
  if (activeLauncherPromise) {
    return activeLauncherPromise;
  }

  activeLauncherPromise = openSessionLauncherInternal();
  try {
    return await activeLauncherPromise;
  } finally {
    activeLauncherPromise = null;
  }
}

async function openSessionLauncherInternal(): Promise<SessionLauncherSelection | null> {
  const [home, roots] = await Promise.all([fetchHomePath(), fetchLauncherRoots()]);
  const homePath = home.homePath || home.path;
  const startPath = home.startPath || homePath;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay session-launcher-overlay';
    let releaseBackButtonLayer: (() => void) | null = null;

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
            <div class="session-launcher-launch" data-role="targets-section" hidden>
              <div class="session-launcher-launch-label">${escapeHtml(t('sessionLauncher.chooseTarget'))}</div>
              <div class="session-launcher-targets" data-role="targets"></div>
            </div>
            <div class="session-launcher-browser" data-role="browser">
              <div class="session-launcher-toolbar">
                <button type="button" class="btn-secondary session-launcher-nav-btn" data-action="home" title="${escapeHtml(t('sessionLauncher.home'))}">
                  <span class="session-launcher-nav-icon" aria-hidden="true">&#8962;</span>
                  <span>${escapeHtml(t('sessionLauncher.home'))}</span>
                </button>
                <button type="button" class="btn-secondary session-launcher-nav-btn" data-action="up" title="${escapeHtml(t('sessionLauncher.up'))}">
                  <span class="session-launcher-nav-icon" aria-hidden="true">&#8593;</span>
                  <span>${escapeHtml(t('sessionLauncher.up'))}</span>
                </button>
                <input
                  type="text"
                  class="session-launcher-path"
                  data-role="path"
                  title=""
                  spellcheck="false"
                  autocomplete="off"
                />
              </div>
              <div class="session-launcher-roots" data-role="roots"></div>
              <div class="session-launcher-status" data-role="status" hidden></div>
              <div class="session-launcher-list" data-role="list"></div>
            </div>
            <div class="session-launcher-remote" data-role="remote-browser" hidden>
              <div class="session-launcher-launch-label">${escapeHtml(t('sessionLauncher.remoteWorkingDirectory'))}</div>
              <input
                type="text"
                class="session-launcher-path"
                data-role="remote-path"
                title=""
                spellcheck="false"
                autocomplete="off"
                placeholder="${escapeHtml(t('sessionLauncher.remoteWorkingDirectoryPlaceholder'))}"
              />
              <div class="session-launcher-status" data-role="remote-hint">${escapeHtml(t('sessionLauncher.remoteWorkingDirectoryHint'))}</div>
            </div>
            <div class="session-launcher-launch">
              <div class="session-launcher-launch-label">${escapeHtml(t('sessionLauncher.chooseProvider'))}</div>
              <div class="session-launcher-providers" data-role="providers"></div>
              <div class="session-launcher-provider-hint" data-role="provider-hint" hidden></div>
            </div>
          </div>
          <div class="modal-footer session-launcher-footer">
            <button type="button" class="btn-secondary" data-role="cancel">${escapeHtml(t('dialog.cancel'))}</button>
          </div>
        </div>
      </div>
    `;

    const state: LauncherState = {
      homePath,
      startPath,
      currentPath: startPath,
      pathDraft: startPath,
      pathHistory: [],
      parentPath: null,
      roots: roots.entries,
      entries: [],
      loading: false,
      error: null,
      requestToken: 0,
      targets: buildSessionLauncherTargets(getLaunchableHubMachines()),
      selectedTargetId: LOCAL_TARGET_ID,
      remotePathDrafts: {},
    };

    const providersEl = overlay.querySelector<HTMLElement>('[data-role="providers"]');
    const targetsSectionEl = overlay.querySelector<HTMLElement>('[data-role="targets-section"]');
    const targetsEl = overlay.querySelector<HTMLElement>('[data-role="targets"]');
    const browserEl = overlay.querySelector<HTMLElement>('[data-role="browser"]');
    const remoteBrowserEl = overlay.querySelector<HTMLElement>('[data-role="remote-browser"]');
    const remotePathEl = overlay.querySelector<HTMLInputElement>('[data-role="remote-path"]');
    const providerHintEl = overlay.querySelector<HTMLElement>('[data-role="provider-hint"]');
    const pathEl = overlay.querySelector<HTMLInputElement>('[data-role="path"]');
    const rootsEl = overlay.querySelector<HTMLElement>('[data-role="roots"]');
    const statusEl = overlay.querySelector<HTMLElement>('[data-role="status"]');
    const listEl = overlay.querySelector<HTMLElement>('[data-role="list"]');
    const cancelButtons = overlay.querySelectorAll<HTMLElement>('[data-role="cancel"]');

    if (
      !providersEl ||
      !targetsSectionEl ||
      !targetsEl ||
      !browserEl ||
      !remoteBrowserEl ||
      !remotePathEl ||
      !providerHintEl ||
      !pathEl ||
      !rootsEl ||
      !statusEl ||
      !listEl
    ) {
      overlay.remove();
      resolve(null);
      return;
    }

    const safeProvidersEl = providersEl;
    const safeTargetsSectionEl = targetsSectionEl;
    const safeTargetsEl = targetsEl;
    const safeBrowserEl = browserEl;
    const safeRemoteBrowserEl = remoteBrowserEl;
    const safeRemotePathEl = remotePathEl;
    const safeProviderHintEl = providerHintEl;
    const safePathEl = pathEl;
    const safeRootsEl = rootsEl;
    const safeStatusEl = statusEl;
    const safeListEl = listEl;
    const releaseHubStateSubscription = subscribeHubState(() => {
      render();
    });

    let pathFollowTimer: number | null = null;
    let skipNextPathCommit = false;

    function clearPendingPathFollow(): void {
      if (pathFollowTimer !== null) {
        window.clearTimeout(pathFollowTimer);
        pathFollowTimer = null;
      }
    }

    function close(result: SessionLauncherSelection | null): void {
      clearPendingPathFollow();
      document.removeEventListener('keydown', onKeyDown);
      releaseHubStateSubscription();
      releaseBackButtonLayer?.();
      releaseBackButtonLayer = null;
      overlay.remove();
      resolve(result);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
      }
    }

    function getSelectedTarget(): SessionLauncherTarget {
      return (
        state.targets.find((target) => target.id === state.selectedTargetId) ?? {
          id: LOCAL_TARGET_ID,
          kind: 'local',
        }
      );
    }

    function refreshTargets(): void {
      state.targets = buildSessionLauncherTargets(getLaunchableHubMachines());
      if (!state.targets.some((target) => target.id === state.selectedTargetId)) {
        state.selectedTargetId = LOCAL_TARGET_ID;
      }
    }

    function renderTargets(): void {
      const showTargets = state.targets.length > 1;
      safeTargetsSectionEl.hidden = !showTargets;
      if (!showTargets) {
        safeTargetsEl.innerHTML = '';
        return;
      }

      safeTargetsEl.innerHTML = state.targets
        .map((target) => {
          const active = state.selectedTargetId === target.id ? ' active' : '';
          if (target.kind === 'local') {
            return `
              <button type="button" class="session-launcher-target${active}" data-target-id="${escapeHtml(target.id)}">
                <span class="session-launcher-target-title">${escapeHtml(t('sessionLauncher.localTargetTitle'))}</span>
                <span class="session-launcher-target-description">${escapeHtml(t('sessionLauncher.localTargetDescription'))}</span>
              </button>
            `;
          }

          return `
            <button type="button" class="session-launcher-target${active}" data-target-id="${escapeHtml(target.id)}">
              <span class="session-launcher-target-title">${escapeHtml(target.machineName)}</span>
              <span class="session-launcher-target-description">${escapeHtml(target.baseUrl)}</span>
            </button>
          `;
        })
        .join('');
    }

    function renderLocationMode(): void {
      const target = getSelectedTarget();
      const isLocalTarget = syncLocationPickerVisibility(target, {
        localBrowser: safeBrowserEl,
        remoteBrowser: safeRemoteBrowserEl,
      });

      if (!isLocalTarget) {
        const currentDraft = state.remotePathDrafts[target.id] ?? '';
        if (safeRemotePathEl.value !== currentDraft) {
          safeRemotePathEl.value = currentDraft;
        }
        safeRemotePathEl.title = currentDraft;
      }
    }

    function renderProviders(): void {
      const target = getSelectedTarget();
      safeProvidersEl.innerHTML = getProviders()
        .map((definition) => {
          const supported = isProviderSupportedOnTarget(definition.provider, target);
          const badge = definition.beta
            ? `<span class="feature-beta-badge">${escapeHtml(t('common.beta'))}</span>`
            : '';
          return `
            <button
              type="button"
              class="session-launcher-provider"
              data-provider="${definition.provider}"
              title="${escapeHtml(definition.launchLabel)}"
              aria-label="${escapeHtml(definition.launchLabel)}"
              ${!supported || (target.kind === 'local' && (state.loading || !state.currentPath)) ? 'disabled' : ''}
            >
              <span class="session-launcher-provider-heading">
                <span class="session-launcher-provider-title">${escapeHtml(definition.title)}</span>
                ${badge}
              </span>
              <span class="session-launcher-provider-description">${escapeHtml(definition.description)}</span>
            </button>
          `;
        })
        .join('');

      const showProviderHint = target.kind === 'hub';
      safeProviderHintEl.hidden = !showProviderHint;
      safeProviderHintEl.textContent = showProviderHint
        ? t('sessionLauncher.remoteTerminalOnly')
        : '';
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
      safeStatusEl.hidden = !shouldShow;
      safeStatusEl.classList.toggle('error', Boolean(state.error));
      safeStatusEl.textContent = state.loading ? t('sessionLauncher.loading') : (state.error ?? '');
    }

    function renderList(): void {
      if (state.entries.length === 0) {
        safeListEl.innerHTML = `<div class="session-launcher-empty">${escapeHtml(t('sessionLauncher.empty'))}</div>`;
        return;
      }

      safeListEl.innerHTML = state.entries
        .map((entry) => {
          return `
            <button
              type="button"
              class="session-launcher-row"
              data-open-path="${escapeHtml(entry.fullPath)}"
              title="${escapeHtml(entry.fullPath)}"
            >
              <span class="session-launcher-row-icon" aria-hidden="true">&#xea83;</span>
              <span class="session-launcher-row-label">${escapeHtml(entry.name)}</span>
            </button>
          `;
        })
        .join('');
    }

    function render(): void {
      refreshTargets();
      renderTargets();
      renderLocationMode();
      renderProviders();
      renderRoots();
      renderStatus();
      renderList();

      if (safePathEl.value !== state.pathDraft) {
        safePathEl.value = state.pathDraft;
      }
      safePathEl.title = state.pathDraft;
    }

    async function loadDirectory(
      path: string,
      options?: {
        recordHistory?: boolean;
        suppressErrors?: boolean;
      },
    ): Promise<boolean> {
      const previousPath = state.currentPath;
      const requestToken = ++state.requestToken;
      state.loading = true;
      if (!options?.suppressErrors) {
        state.error = null;
      }
      render();

      try {
        const response = await fetchDirectories(path);
        if (requestToken !== state.requestToken) {
          return false;
        }

        state.currentPath = response.path;
        state.pathDraft = response.path;
        state.parentPath = response.parentPath;
        state.entries = response.entries;
        if (
          options?.recordHistory !== false &&
          previousPath &&
          previousPath !== response.path &&
          state.pathHistory[state.pathHistory.length - 1] !== previousPath
        ) {
          state.pathHistory.push(previousPath);
        }
        state.error = null;
        return true;
      } catch (error) {
        if (requestToken !== state.requestToken) {
          return false;
        }

        if (!options?.suppressErrors) {
          state.error = error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (requestToken === state.requestToken) {
          state.loading = false;
          render();
        }
      }

      return false;
    }

    async function navigateBackInHistory(): Promise<boolean> {
      clearPendingPathFollow();
      while (state.pathHistory.length > 0) {
        const previousPath = state.pathHistory.pop();
        if (!previousPath || previousPath === state.currentPath) {
          continue;
        }

        const loaded = await loadDirectory(previousPath, { recordHistory: false });
        if (loaded) {
          return true;
        }
      }

      return false;
    }

    function queuePathFollow(): void {
      clearPendingPathFollow();

      pathFollowTimer = window.setTimeout(() => {
        pathFollowTimer = null;
        const candidatePath = state.pathDraft.trim();
        if (!candidatePath || candidatePath === state.currentPath) {
          return;
        }

        void loadDirectory(candidatePath, { suppressErrors: true });
      }, 280);
    }

    async function commitPathDraft(): Promise<void> {
      clearPendingPathFollow();

      const candidatePath = state.pathDraft.trim();
      if (!candidatePath) {
        state.error = 'Path is required';
        render();
        return;
      }

      if (candidatePath === state.currentPath) {
        state.error = null;
        render();
        return;
      }

      await loadDirectory(candidatePath);
    }

    render();
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown);
    releaseBackButtonLayer = registerBackButtonLayer(() => {
      if (state.loading) {
        return;
      }

      void (async () => {
        const navigated = await navigateBackInHistory();
        if (!navigated) {
          close(null);
        }
      })();
    });
    void loadDirectory(state.startPath, { recordHistory: false });
    void refreshHubState().catch(() => {});

    function launch(provider: LauncherProvider): void {
      const target = getSelectedTarget();
      if (!isProviderSupportedOnTarget(provider, target)) {
        return;
      }

      if (target.kind === 'local' && (state.loading || !state.currentPath)) {
        return;
      }

      close({
        provider,
        workingDirectory:
          target.kind === 'local'
            ? state.currentPath
            : state.remotePathDrafts[target.id]?.trim() || null,
        target,
      });
    }

    safeProvidersEl.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-provider]');
      if (!target) {
        return;
      }

      launch(target.dataset.provider as LauncherProvider);
    });

    safeTargetsEl.addEventListener('click', (event) => {
      const targetId = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        '[data-target-id]',
      )?.dataset.targetId;
      if (!targetId || state.selectedTargetId === targetId) {
        return;
      }

      clearPendingPathFollow();
      state.selectedTargetId = targetId;
      render();
    });

    safeRootsEl.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-root-path]');
      const rootPath = target?.dataset.rootPath;
      if (!rootPath) {
        return;
      }

      clearPendingPathFollow();
      void loadDirectory(rootPath);
    });

    safeListEl.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const openPath = target?.closest<HTMLElement>('[data-open-path]')?.dataset.openPath;
      if (openPath) {
        clearPendingPathFollow();
        void loadDirectory(openPath);
      }
    });

    safePathEl.addEventListener('input', () => {
      state.pathDraft = safePathEl.value;
      queuePathFollow();
    });

    safeRemotePathEl.addEventListener('input', () => {
      state.remotePathDrafts[state.selectedTargetId] = safeRemotePathEl.value;
      safeRemotePathEl.title = safeRemotePathEl.value;
    });

    safePathEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void commitPathDraft();
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        state.pathDraft = state.currentPath;
        state.error = null;
        render();
      }
    });

    safePathEl.addEventListener('blur', () => {
      if (skipNextPathCommit) {
        skipNextPathCommit = false;
        return;
      }

      void commitPathDraft();
    });

    overlay.addEventListener('pointerdown', (event) => {
      const target = event.target as HTMLElement | null;
      if (
        document.activeElement === safePathEl &&
        target?.closest(
          '[data-open-path], [data-root-path], [data-action], [data-provider], [data-target-id], [data-role="cancel"]',
        )
      ) {
        skipNextPathCommit = true;
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
        clearPendingPathFollow();
        void loadDirectory(state.homePath);
      } else if (action === 'up' && state.parentPath) {
        clearPendingPathFollow();
        void loadDirectory(state.parentPath);
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
  launchLabel: string;
  beta?: boolean;
}> {
  return [
    {
      provider: 'terminal',
      title: t('sessionLauncher.terminalTitle'),
      description: t('sessionLauncher.terminalDescription'),
      launchLabel: t('sessionLauncher.startTerminal'),
    },
    {
      provider: 'codex',
      title: t('sessionLauncher.codexTitle'),
      description: t('sessionLauncher.codexDescription'),
      launchLabel: t('sessionLauncher.startCodex'),
      beta: true,
    },
    {
      provider: 'claude',
      title: t('sessionLauncher.claudeTitle'),
      description: t('sessionLauncher.claudeDescription'),
      launchLabel: t('sessionLauncher.startClaude'),
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
