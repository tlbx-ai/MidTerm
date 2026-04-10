import type {
  ShellType,
  Session,
  LaunchEntry,
  SpaceSummaryDto,
  SpaceWorkspaceDto,
} from '../../api/types';
import { t } from '../i18n';
import { getLaunchableHubMachines } from '../hub/runtime';
import { invalidateSidebarSpacesTree } from '../sidebar/spacesTreeSidebar';
import { showAlert, showConfirm } from '../../utils/dialog';
import { showCreateWorktreeDialog, showImportSpaceDialog } from './spacesDialogs';
import { launchRecentEntry, launchSpaceWorkspace, type SpaceSurface } from './runtime';
import {
  createHubWorktree,
  createLocalWorktree,
  deleteHubWorktree,
  deleteLocalWorktree,
  fetchHubRecents,
  fetchHubSpaces,
  fetchLocalRecents,
  fetchLocalSpaces,
  importHubSpace,
  importLocalSpace,
  initHubGit,
  initLocalGit,
  updateHubWorkspace,
  updateLocalWorkspace,
} from './spacesApi';

interface SpaceTargetSection {
  id: string;
  label: string;
  machineId: string | null;
  spaces: SpaceSummaryDto[];
  recents: LaunchEntry[];
}

interface SpacesDropdownOptions {
  resolveLaunchDimensions: () => Promise<{ cols: number; rows: number }>;
  resolveShell: () => ShellType | null;
  onOpenLocalSession: (session: Session, surface: SpaceSurface) => void | Promise<void>;
  onOpenRemoteSession: (
    machineId: string,
    sessionId: string,
    surface: SpaceSurface,
  ) => void | Promise<void>;
  onSelectLocalSession: (sessionId: string) => void;
  onSelectRemoteSession: (machineId: string, sessionId: string) => void;
  onLaunchRecent: (machineId: string | null, entry: LaunchEntry) => void;
}

let dropdownEl: HTMLElement | null = null;
let isOpen = false;
let activeLoadToken = 0;
let options: SpacesDropdownOptions | null = null;
let sections: SpaceTargetSection[] = [];

export function initSpacesDropdown(nextOptions: SpacesDropdownOptions): void {
  options = nextOptions;
  createDropdownElement();
}

export function toggleSpacesDropdown(): void {
  if (isOpen) {
    closeSpacesDropdown();
  } else {
    openSpacesDropdown();
  }
}

export function closeSpacesDropdown(): void {
  if (!dropdownEl) return;

  dropdownEl.classList.remove('visible');
  isOpen = false;
  document.removeEventListener('click', handleOutsideClick);
}

export function openSpacesDropdown(): void {
  if (!dropdownEl) {
    return;
  }

  void refreshSpacesDropdown().then(() => {
    if (!dropdownEl) {
      return;
    }

    positionDropdown();
    dropdownEl.classList.add('visible');
    isOpen = true;
    setTimeout(() => {
      document.addEventListener('click', handleOutsideClick);
    }, 0);
  });
}

async function refreshSpacesDropdown(): Promise<void> {
  if (!dropdownEl) {
    return;
  }

  const currentToken = ++activeLoadToken;
  const nextSections = await loadSections();
  if (currentToken !== activeLoadToken) {
    return;
  }

  sections = nextSections;
  renderDropdownContent();
}

async function loadSections(): Promise<SpaceTargetSection[]> {
  const machines = getLaunchableHubMachines();
  const results: SpaceTargetSection[] = [];

  try {
    const [spaces, recents] = await Promise.all([fetchLocalSpaces(), fetchLocalRecents()]);
    results.push({
      id: 'local',
      label: t('sessionLauncher.localTargetTitle'),
      machineId: null,
      spaces,
      recents,
    });
  } catch {
    results.push({
      id: 'local',
      label: t('sessionLauncher.localTargetTitle'),
      machineId: null,
      spaces: [],
      recents: [],
    });
  }

  const remoteSections = await Promise.all(
    machines.map(async (machine) => {
      try {
        const [spaces, recents] = await Promise.all([
          fetchHubSpaces(machine.machine.id),
          fetchHubRecents(machine.machine.id),
        ]);
        return {
          id: machine.machine.id,
          label: machine.machine.name,
          machineId: machine.machine.id,
          spaces,
          recents,
        } satisfies SpaceTargetSection;
      } catch {
        return {
          id: machine.machine.id,
          label: machine.machine.name,
          machineId: machine.machine.id,
          spaces: [],
          recents: [],
        } satisfies SpaceTargetSection;
      }
    }),
  );

  return [...results, ...remoteSections];
}

function createDropdownElement(): void {
  dropdownEl = document.createElement('div');
  dropdownEl.className = 'history-dropdown spaces-dropdown';
  dropdownEl.innerHTML = `
    <div class="history-dropdown-header">
      <span>${t('spaces.title')}</span>
      <button type="button" class="history-item-rename spaces-add-btn" data-action="add-root">${t('spaces.add')}</button>
    </div>
    <div class="history-dropdown-content"></div>
    <div class="history-dropdown-empty">${t('spaces.empty')}</div>
  `;

  dropdownEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }

    const actionEl = target.closest<HTMLElement>('[data-action]');
    if (!actionEl) {
      return;
    }

    const action = actionEl.dataset.action;
    if (!action) {
      return;
    }

    const machineId = actionEl.dataset.machineId ?? null;
    const spaceId = actionEl.dataset.spaceId ?? null;
    const workspaceKey = actionEl.dataset.workspaceKey ?? null;
    const surface = (actionEl.dataset.surface as SpaceSurface | undefined) ?? 'terminal';
    const sessionId = actionEl.dataset.sessionId ?? null;
    const recentId = actionEl.dataset.recentId ?? null;

    void handleAction({ action, machineId, spaceId, workspaceKey, surface, sessionId, recentId });
  });

  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.appendChild(dropdownEl);
  }
}

async function handleAction(args: {
  action: string;
  machineId: string | null;
  spaceId: string | null;
  workspaceKey: string | null;
  surface: SpaceSurface;
  sessionId: string | null;
  recentId: string | null;
}): Promise<void> {
  if (!options) {
    return;
  }

  if (handleImmediateAction(args)) {
    return;
  }

  if (await handleWorkspaceManagementAction(args)) {
    return;
  }

  switch (args.action) {
    case 'add-root':
      await promptAndImportSpace(null);
      return;
    case 'add-space':
      await promptAndImportSpace(args.machineId);
      return;
  }
}

function handleImmediateAction(args: {
  action: string;
  machineId: string | null;
  sessionId: string | null;
  recentId: string | null;
}): boolean {
  if (args.action === 'open-session') {
    handleOpenSessionAction(args.machineId, args.sessionId);
    return true;
  }

  if (args.action === 'launch-recent') {
    handleLaunchRecentAction(args.recentId);
    return true;
  }

  return false;
}

async function handleWorkspaceManagementAction(args: {
  action: string;
  machineId: string | null;
  spaceId: string | null;
  workspaceKey: string | null;
  surface: SpaceSurface;
}): Promise<boolean> {
  if (args.action === 'init-git' && args.spaceId) {
    await initGit(args.machineId, args.spaceId);
    return true;
  }

  if (args.action === 'new-worktree' && args.spaceId) {
    await promptAndCreateWorktree(args.machineId, args.spaceId);
    return true;
  }

  if (args.action === 'rename-worktree' && args.spaceId && args.workspaceKey) {
    await promptAndRenameWorktree(args.machineId, args.spaceId, args.workspaceKey);
    return true;
  }

  if (args.action === 'delete-worktree' && args.spaceId && args.workspaceKey) {
    await promptAndDeleteWorktree(args.machineId, args.spaceId, args.workspaceKey);
    return true;
  }

  if (args.action === 'launch' && args.spaceId && args.workspaceKey) {
    await launchWorkspace(args.machineId, args.spaceId, args.workspaceKey, args.surface);
    return true;
  }

  return false;
}

function handleOpenSessionAction(machineId: string | null, sessionId: string | null): void {
  if (!options || !sessionId) {
    return;
  }

  if (machineId) {
    options.onSelectRemoteSession(machineId, sessionId);
  } else {
    options.onSelectLocalSession(sessionId);
  }

  closeSpacesDropdown();
}

function handleLaunchRecentAction(recentId: string | null): void {
  if (!options || !recentId) {
    return;
  }

  const entry = sections
    .flatMap((section) => section.recents)
    .find((recent) => recent.id === recentId);
  if (!entry) {
    return;
  }

  void launchRecentEntry(
    sections.find((section) => section.recents.some((recent) => recent.id === recentId))
      ?.machineId ?? null,
    entry,
  );
  closeSpacesDropdown();
}

async function promptAndImportSpace(machineId: string | null): Promise<void> {
  const request = await showImportSpaceDialog({ machineId });
  if (!request) {
    return;
  }

  try {
    if (machineId) {
      await importHubSpace(machineId, request);
    } else {
      await importLocalSpace(request);
    }
    await refreshSpacesDropdown();
    invalidateSidebarSpacesTree();
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: t('spaces.importFailed'),
    });
  }
}

async function initGit(machineId: string | null, spaceId: string): Promise<void> {
  try {
    if (machineId) {
      await initHubGit(machineId, spaceId);
    } else {
      await initLocalGit(spaceId);
    }
    await refreshSpacesDropdown();
    invalidateSidebarSpacesTree();
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: t('spaces.gitInitFailed'),
    });
  }
}

async function promptAndCreateWorktree(machineId: string | null, spaceId: string): Promise<void> {
  const space = findSpace(machineId, spaceId);
  if (!space) {
    return;
  }

  const request = await showCreateWorktreeDialog({ machineId, space });
  if (!request) {
    return;
  }

  try {
    if (machineId) {
      await createHubWorktree(machineId, spaceId, request);
    } else {
      await createLocalWorktree(spaceId, request);
    }
    await refreshSpacesDropdown();
    invalidateSidebarSpacesTree();
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: t('spaces.worktreeCreateFailed'),
    });
  }
}

async function promptAndRenameWorktree(
  machineId: string | null,
  spaceId: string,
  workspaceKey: string,
): Promise<void> {
  const workspace = findWorkspace(machineId, spaceId, workspaceKey);
  if (!workspace || workspace.isMain) {
    return;
  }

  const nextName = prompt(t('spaces.renameWorktreePrompt'), workspace.displayName);
  if (nextName === null) {
    return;
  }

  try {
    if (machineId) {
      await updateHubWorkspace(machineId, spaceId, workspaceKey, {
        label: nextName.trim() || null,
      });
    } else {
      await updateLocalWorkspace(spaceId, workspaceKey, {
        label: nextName.trim() || null,
      });
    }

    await refreshSpacesDropdown();
    invalidateSidebarSpacesTree();
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: t('spaces.renameWorktreeFailed'),
    });
  }
}

async function promptAndDeleteWorktree(
  machineId: string | null,
  spaceId: string,
  workspaceKey: string,
): Promise<void> {
  const workspace = findWorkspace(machineId, spaceId, workspaceKey);
  if (!workspace || workspace.isMain) {
    return;
  }

  if (workspace.activeSessions.length > 0) {
    await showAlert(t('spaces.deleteWorktreeActiveSessions'), {
      title: t('spaces.deleteWorktreeBlockedTitle'),
    });
    return;
  }

  const confirmed = await showConfirm(
    t('spaces.deleteWorktreeConfirm').replace('{name}', workspace.displayName),
    {
      title: t('spaces.deleteWorktreeTitle'),
    },
  );
  if (!confirmed) {
    return;
  }

  let force = false;
  if (workspace.hasChanges) {
    const dirtyConfirmed = await showConfirm(
      t('spaces.deleteWorktreeDirtyConfirm').replace('{name}', workspace.displayName),
      {
        title: t('spaces.deleteWorktreeDirtyTitle'),
      },
    );
    if (!dirtyConfirmed) {
      return;
    }

    const finalConfirmed = await showConfirm(
      t('spaces.deleteWorktreeDirtyFinalConfirm').replace('{name}', workspace.displayName),
      {
        title: t('spaces.deleteWorktreeDirtyFinalTitle'),
      },
    );
    if (!finalConfirmed) {
      return;
    }

    force = true;
  }

  try {
    if (machineId) {
      await deleteHubWorktree(machineId, spaceId, workspaceKey, { force });
    } else {
      await deleteLocalWorktree(spaceId, workspaceKey, { force });
    }

    await refreshSpacesDropdown();
    invalidateSidebarSpacesTree();
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: t('spaces.deleteWorktreeFailed'),
    });
  }
}

async function launchWorkspace(
  machineId: string | null,
  spaceId: string,
  workspaceKey: string,
  surface: SpaceSurface,
): Promise<void> {
  if (!options) {
    return;
  }

  const workspace = sections
    .flatMap((section) => section.spaces)
    .find((space) => space.id === spaceId)
    ?.workspaces.find((candidate) => candidate.key === workspaceKey);
  if (!workspace) {
    return;
  }

  const launched = await launchSpaceWorkspace(machineId, spaceId, workspace, surface);
  if (launched) {
    closeSpacesDropdown();
  }
}

function positionDropdown(): void {
  if (!dropdownEl) return;

  const trigger = document.getElementById('btn-history');
  const sidebar = document.getElementById('sidebar');
  if (!(trigger instanceof HTMLElement) || !(sidebar instanceof HTMLElement)) {
    return;
  }

  const triggerRect = trigger.getBoundingClientRect();
  const sidebarRect = sidebar.getBoundingClientRect();
  const top = Math.round(triggerRect.bottom - sidebarRect.top + 4);
  const availableHeight = Math.max(160, Math.floor(sidebarRect.bottom - triggerRect.bottom - 12));

  dropdownEl.style.top = `${top}px`;
  dropdownEl.style.left = '8px';
  dropdownEl.style.right = '8px';
  dropdownEl.style.maxHeight = `${availableHeight}px`;
}

function renderDropdownContent(): void {
  if (!dropdownEl) {
    return;
  }

  const content = dropdownEl.querySelector('.history-dropdown-content');
  const empty = dropdownEl.querySelector('.history-dropdown-empty');
  if (!(content instanceof HTMLElement) || !(empty instanceof HTMLElement)) {
    return;
  }

  if (sections.every((section) => section.spaces.length === 0 && section.recents.length === 0)) {
    content.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  content.classList.remove('hidden');
  empty.classList.add('hidden');
  content.innerHTML = '';

  for (const section of sections) {
    const sectionEl = document.createElement('section');
    sectionEl.className = 'spaces-section';

    sectionEl.innerHTML = `
      <div class="history-section-header spaces-section-header">
        <span>${escapeHtml(section.label)}</span>
        <button type="button" class="history-item-rename spaces-add-btn" data-action="add-space" data-machine-id="${escapeHtml(section.machineId ?? '')}">
          ${escapeHtml(t('spaces.add'))}
        </button>
      </div>
    `;

    const body = document.createElement('div');
    body.className = 'spaces-section-body';

    for (const space of section.spaces) {
      body.appendChild(createSpaceCard(space, section.machineId));
    }

    if (section.recents.length > 0) {
      const recentsHeader = document.createElement('div');
      recentsHeader.className = 'history-section-header';
      recentsHeader.textContent = t('spaces.recents');
      body.appendChild(recentsHeader);
      for (const recent of section.recents) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'history-item spaces-recent-item';
        row.dataset.action = 'launch-recent';
        row.dataset.recentId = recent.id;
        row.innerHTML = `
          <span class="history-item-label">${escapeHtml(recent.label || recent.executable || recent.workingDirectory)}</span>
          <span class="history-item-command">${escapeHtml(recent.workingDirectory || '')}</span>
        `;
        body.appendChild(row);
      }
    }

    sectionEl.appendChild(body);
    content.appendChild(sectionEl);
  }
}

function createSpaceCard(space: SpaceSummaryDto, machineId: string | null): HTMLElement {
  const article = document.createElement('article');
  article.className = 'spaces-card';

  const header = document.createElement('div');
  header.className = 'spaces-card-header';
  const kindBadge = space.kind === 'git' ? 'git' : 'dir';
  header.innerHTML = `
    <div class="spaces-card-title-wrap">
      <span class="history-item-mode">${escapeHtml(kindBadge.toUpperCase())}</span>
      <span class="history-item-label">${escapeHtml(space.label)}</span>
    </div>
    <div class="spaces-card-actions">
      ${
        space.kind === 'git'
          ? `<button type="button" class="history-item-rename" data-action="new-worktree" data-space-id="${escapeHtml(space.id)}" data-machine-id="${escapeHtml(machineId ?? '')}">${escapeHtml(t('spaces.newWorktree'))}</button>`
          : `<button type="button" class="history-item-rename" data-action="init-git" data-space-id="${escapeHtml(space.id)}" data-machine-id="${escapeHtml(machineId ?? '')}">${escapeHtml(t('spaces.initGit'))}</button>`
      }
    </div>
  `;
  article.appendChild(header);

  const subtitle = document.createElement('div');
  subtitle.className = 'history-item-command spaces-card-path';
  subtitle.textContent = space.rootPath;
  subtitle.title = space.rootPath;
  article.appendChild(subtitle);

  const workspacesWrap = document.createElement('div');
  workspacesWrap.className = 'spaces-workspaces';
  for (const workspace of space.workspaces) {
    workspacesWrap.appendChild(createWorkspaceRow(space.id, workspace, machineId));
  }
  article.appendChild(workspacesWrap);
  return article;
}

function createWorkspaceRow(
  spaceId: string,
  workspace: SpaceWorkspaceDto,
  machineId: string | null,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'spaces-workspace-row';

  const meta = document.createElement('div');
  meta.className = 'spaces-workspace-meta';
  meta.innerHTML = `
    <div class="spaces-workspace-line">
      <span class="spaces-workspace-name">${escapeHtml(displayWorkspaceName(workspace))}</span>
      ${workspace.branch ? `<span class="spaces-workspace-branch">${escapeHtml(workspace.branch)}</span>` : ''}
      ${workspace.hasChanges ? `<span class="spaces-workspace-badge">${workspace.changeCount}</span>` : ''}
      ${workspace.hasActiveAiSession ? `<span class="spaces-workspace-badge warning">${escapeHtml(t('spaces.aiBusy'))}</span>` : ''}
    </div>
    <div class="history-item-command">${escapeHtml(workspace.path)}</div>
  `;
  row.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'spaces-workspace-actions';
  if (workspace.kind === 'worktree' && !workspace.isMain) {
    actions.innerHTML = `
      <button
        type="button"
        class="history-item-rename"
        data-action="rename-worktree"
        data-space-id="${escapeHtml(spaceId)}"
        data-machine-id="${escapeHtml(machineId ?? '')}"
        data-workspace-key="${escapeHtml(workspace.key)}"
        title="${escapeHtml(t('spaces.renameWorktree'))}"
      >
        ${escapeHtml(t('spaces.renameWorktreeShort'))}
      </button>
      <button
        type="button"
        class="history-item-delete"
        data-action="delete-worktree"
        data-space-id="${escapeHtml(spaceId)}"
        data-machine-id="${escapeHtml(machineId ?? '')}"
        data-workspace-key="${escapeHtml(workspace.key)}"
        title="${escapeHtml(t('spaces.deleteWorktree'))}"
      >
        ${escapeHtml(t('spaces.deleteWorktreeShort'))}
      </button>
    `;
  }
  actions.innerHTML += buildLaunchButton(
    spaceId,
    workspace.key,
    machineId,
    'terminal',
    t('session.terminal'),
  );
  actions.innerHTML += buildLaunchButton(
    spaceId,
    workspace.key,
    machineId,
    'codex',
    t('sessionLauncher.codexTitle'),
  );
  actions.innerHTML += buildLaunchButton(
    spaceId,
    workspace.key,
    machineId,
    'claude',
    t('sessionLauncher.claudeTitle'),
  );
  row.appendChild(actions);

  if (workspace.activeSessions.length > 0) {
    const sessions = document.createElement('div');
    sessions.className = 'spaces-workspace-sessions';
    sessions.innerHTML = workspace.activeSessions
      .map(
        (session) => `
          <button
            type="button"
            class="spaces-session-pill"
            data-action="open-session"
            data-machine-id="${escapeHtml(machineId ?? '')}"
            data-session-id="${escapeHtml(session.sessionId)}"
          >
            ${escapeHtml(session.title)}
          </button>
        `,
      )
      .join('');
    row.appendChild(sessions);
  }

  return row;
}

function buildLaunchButton(
  spaceId: string,
  workspaceKey: string,
  machineId: string | null,
  surface: SpaceSurface,
  label: string,
): string {
  return `
    <button
      type="button"
      class="btn-secondary spaces-launch-btn"
      data-action="launch"
      data-space-id="${escapeHtml(spaceId)}"
      data-machine-id="${escapeHtml(machineId ?? '')}"
      data-workspace-key="${escapeHtml(workspaceKey)}"
      data-surface="${escapeHtml(surface)}"
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function displayWorkspaceName(workspace: SpaceWorkspaceDto): string {
  if (workspace.displayName.trim()) {
    return workspace.displayName;
  }

  if (workspace.isMain) {
    return t('spaces.mainWorkspace');
  }

  return getPathTail(workspace.path) || workspace.path;
}

function findSpace(machineId: string | null, spaceId: string): SpaceSummaryDto | undefined {
  return sections
    .find((section) => section.machineId === machineId)
    ?.spaces.find((space) => space.id === spaceId);
}

function findWorkspace(
  machineId: string | null,
  spaceId: string,
  workspaceKey: string,
): SpaceWorkspaceDto | undefined {
  return findSpace(machineId, spaceId)?.workspaces.find(
    (workspace) => workspace.key === workspaceKey,
  );
}

function handleOutsideClick(event: MouseEvent): void {
  if (!dropdownEl) {
    return;
  }

  const target = event.target as HTMLElement | null;
  if (!target) {
    return;
  }

  if (!dropdownEl.contains(target) && !target.closest('.btn-history')) {
    closeSpacesDropdown();
  }
}

function getPathTail(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const separatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
