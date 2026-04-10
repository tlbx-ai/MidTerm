import type { LaunchEntry, Session, SpaceSummaryDto, SpaceWorkspaceDto } from '../../api/types';
import { t } from '../i18n';
import { dom } from '../../state';
import { $activeSessionId, $sessionList, $settingsOpen } from '../../stores';
import { getLaunchableHubMachines, getHubSidebarSections } from '../hub/runtime';
import { showAlert, showConfirm, showTextPrompt } from '../../utils/dialog';
import {
  createHubWorktree,
  createLocalWorktree,
  deleteHubSpace,
  deleteHubWorktree,
  deleteLocalSpace,
  deleteLocalWorktree,
  fetchHubRecents,
  fetchHubSpaces,
  fetchLocalRecents,
  fetchLocalSpaces,
  importHubSpace,
  importLocalSpace,
  initHubGit,
  initLocalGit,
  updateHubSpace,
  updateHubWorkspace,
  updateLocalSpace,
  updateLocalWorkspace,
} from '../spaces/spacesApi';
import { showCreateWorktreeDialog, showImportSpaceDialog } from '../spaces/spacesDialogs';
import { launchRecentEntry, launchSpaceWorkspace, type SpaceSurface } from '../spaces/runtime';
import { getSessionDisplayName as getLegacySessionDisplayName } from './sessionList';

export interface SessionListCallbacks {
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string) => void;
  onToggleAgentControl: (sessionId: string) => void;
  onPinToHistory: (sessionId: string) => void;
  onEnableMidtermFeatures?: (sessionId: string) => void;
  onCloseSidebar: () => void;
  onLaunchRecent?: (machineId: string | null, entry: LaunchEntry) => void;
}

export function getSessionDisplayName(session: Session): string {
  return getLegacySessionDisplayName(session);
}

interface SidebarSpaceSection {
  id: string;
  label: string;
  machineId: string | null;
  spaces: SpaceSummaryDto[];
  recents: LaunchEntry[];
}

interface SidebarSessionRef {
  id: string;
  machineId: string | null;
  session: Session;
}

let callbacks: SessionListCallbacks | null = null;
let cachedSections: SidebarSpaceSection[] = [];
let loadPromise: Promise<void> | null = null;
let lastLoadedAt = 0;
let loadToken = 0;
let searchValue = '';
let searchBound = false;

const SPACE_COLLAPSE_PREFIX = 'midterm.sidebar.spaceCollapsed.';
const TREE_TTL_MS = 15_000;

export function initializeSessionList(): void {
  initializeSearchControls();
  syncSearchControls();
  void refreshSidebarSpacesTree(true);
}

export function setSessionListCallbacks(nextCallbacks: SessionListCallbacks): void {
  callbacks = nextCallbacks;
}

export function invalidateSidebarSpacesTree(): void {
  lastLoadedAt = 0;
  void refreshSidebarSpacesTree(true);
}

export function applySessionFilterSettingChange(): void {
  syncSearchControls();
}

export function renderSessionList(): void {
  if (!dom.sessionList) {
    return;
  }

  if (shouldRefreshSidebarTree()) {
    void refreshSidebarSpacesTree();
  }

  renderSidebarTree();
}

export function updateEmptyState(): void {
  if (!dom.emptyState) {
    return;
  }

  if ($settingsOpen.get()) {
    dom.emptyState.classList.add('hidden');
    return;
  }

  const visibleSections = getVisibleSpaceSections();
  const hasSessions = getAllSidebarSessions().length > 0;
  const hasSpaces = visibleSections.some((section) => section.spaces.length > 0);
  const hasRecents = visibleSections.some((section) => section.recents.length > 0);
  if (hasSessions || hasSpaces || hasRecents) {
    dom.emptyState.classList.add('hidden');
    return;
  }

  dom.emptyState.classList.remove('hidden');
}

export function updateMobileTitle(): void {
  if (!dom.mobileTitle) {
    return;
  }

  const activeSessionId = $activeSessionId.get();
  const activeSession = getAllSidebarSessions().find(
    (entry) => entry.id === activeSessionId,
  )?.session;
  dom.mobileTitle.textContent = activeSession ? getSessionDisplayName(activeSession) : 'MidTerm';
}

async function refreshSidebarSpacesTree(force = false): Promise<void> {
  if (!force && !shouldRefreshSidebarTree()) {
    return;
  }

  if (loadPromise) {
    return loadPromise;
  }

  const currentToken = ++loadToken;
  loadPromise = loadSidebarTreeData(currentToken).finally(() => {
    loadPromise = null;
  });
  return loadPromise;
}

function shouldRefreshSidebarTree(): boolean {
  if (loadPromise) {
    return false;
  }

  const machineIds = getLaunchableHubMachines()
    .map((machine) => machine.machine.id)
    .sort()
    .join('|');
  const cachedMachineIds = cachedSections
    .filter((section) => section.machineId)
    .map((section) => section.machineId)
    .filter((machineId): machineId is string => typeof machineId === 'string')
    .sort()
    .join('|');

  return (
    cachedSections.length === 0 ||
    Date.now() - lastLoadedAt > TREE_TTL_MS ||
    machineIds !== cachedMachineIds
  );
}

async function loadSidebarTreeData(token: number): Promise<void> {
  const machines = getLaunchableHubMachines();
  const [localSpaces, localRecents, remoteSections] = await Promise.all([
    fetchLocalSpaces().catch(() => []),
    fetchLocalRecents().catch(() => []),
    Promise.all(
      machines.map(async (machine) => ({
        id: machine.machine.id,
        label: machine.machine.name,
        machineId: machine.machine.id,
        spaces: await fetchHubSpaces(machine.machine.id).catch(() => []),
        recents: await fetchHubRecents(machine.machine.id).catch(() => []),
      })),
    ),
  ]);

  if (token !== loadToken) {
    return;
  }

  cachedSections = [
    {
      id: 'local',
      label: t('sessionLauncher.localTargetTitle'),
      machineId: null,
      spaces: localSpaces,
      recents: localRecents,
    },
    ...remoteSections,
  ];
  lastLoadedAt = Date.now();
  renderSidebarTree();
  updateEmptyState();
  updateMobileTitle();
}

function renderSidebarTree(): void {
  if (!dom.sessionList) {
    return;
  }

  const host = dom.sessionList;
  host.className = 'session-list spaces-sidebar-tree';
  host.replaceChildren();

  const visibleSections = getVisibleSpaceSections();
  for (const section of visibleSections) {
    host.appendChild(createSpaceTargetSection(section));
  }

  const adHocSessions = getAdHocSessions();
  if (adHocSessions.length > 0) {
    host.appendChild(createAdHocSection(adHocSessions));
  }

  if (host.childElementCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'spaces-sidebar-empty';
    empty.textContent = searchValue ? t('spaces.noSearchMatches') : t('spaces.sidebarEmpty');
    host.appendChild(empty);
  }
}

function getVisibleSpaceSections(): SidebarSpaceSection[] {
  return cachedSections
    .map((section) => filterSection(section))
    .filter((section) => section.spaces.length > 0 || section.recents.length > 0);
}

function filterSection(section: SidebarSpaceSection): SidebarSpaceSection {
  const filteredSpaces = section.spaces
    .map((space) => filterSpace(section.machineId, space))
    .filter((space): space is SpaceSummaryDto => space !== null);
  const filteredRecents = section.recents.filter((recent) => matchesRecentSearch(recent));
  return {
    ...section,
    spaces: filteredSpaces,
    recents: filteredRecents.slice(0, 6),
  };
}

function filterSpace(machineId: string | null, space: SpaceSummaryDto): SpaceSummaryDto | null {
  const hasSession = hasActiveSpaceSession(machineId, space);
  const textMatch = matchesSpaceSearch(space);
  if (!textMatch && !searchValue && !space.isPinned && !hasSession) {
    return null;
  }

  if (!searchValue || textMatch) {
    return space;
  }

  const matchingWorkspaces = space.workspaces.filter((workspace) =>
    matchesWorkspaceSearch(workspace),
  );
  return matchingWorkspaces.length > 0 || hasSession
    ? {
        ...space,
        workspaces: matchingWorkspaces.length > 0 ? matchingWorkspaces : space.workspaces,
      }
    : null;
}

function hasActiveSpaceSession(machineId: string | null, space: SpaceSummaryDto): boolean {
  return getAllSidebarSessions().some((entry) => sessionBelongsToSpace(entry, machineId, space));
}

function getAllSidebarSessions(): SidebarSessionRef[] {
  const localSessions = $sessionList.get().map((session) => ({
    id: session.id,
    machineId: null,
    session,
  }));
  const remoteSessions = getHubSidebarSections().flatMap((machine) =>
    machine.sessions.map((session) => ({
      id: session.id,
      machineId: machine.machine.machine.id,
      session,
    })),
  );
  return [...localSessions, ...remoteSessions];
}

function getAdHocSessions(): SidebarSessionRef[] {
  return getAllSidebarSessions()
    .filter((entry) => !isSessionAdoptedBySpace(entry))
    .filter((entry) => matchesAdHocSearch(entry));
}

function isSessionAdoptedBySpace(entry: SidebarSessionRef): boolean {
  return cachedSections.some(
    (section) =>
      section.machineId === entry.machineId &&
      section.spaces.some((space) => sessionBelongsToSpace(entry, section.machineId, space)),
  );
}

function createSpaceTargetSection(section: SidebarSpaceSection): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.className = 'spaces-tree-target';

  const header = document.createElement('div');
  header.className = 'spaces-tree-target-header';
  header.innerHTML = `
    <span class="spaces-tree-target-label">${escapeHtml(section.label)}</span>
    <span class="spaces-tree-target-count">${section.spaces.length}</span>
  `;

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'spaces-tree-target-action';
  addButton.textContent = t('spaces.add');
  addButton.addEventListener('click', () => {
    void promptAndImportSpace(section.machineId);
  });

  const headerActions = document.createElement('div');
  headerActions.className = 'spaces-tree-target-actions';
  headerActions.appendChild(addButton);
  header.appendChild(headerActions);
  wrapper.appendChild(header);

  if (section.spaces.length > 0) {
    const list = document.createElement('div');
    list.className = 'spaces-tree-space-list';
    for (const space of section.spaces) {
      list.appendChild(createSpaceNode(section.machineId, space));
    }
    wrapper.appendChild(list);
  }

  if (section.recents.length > 0) {
    const recents = document.createElement('div');
    recents.className = 'spaces-tree-recents-block';

    const recentsHeader = document.createElement('div');
    recentsHeader.className = 'spaces-tree-subheader';
    recentsHeader.textContent = t('spaces.recents');
    recents.appendChild(recentsHeader);

    const list = document.createElement('div');
    list.className = 'spaces-tree-recent-list';
    for (const recent of section.recents) {
      list.appendChild(createRecentNode(section.machineId, recent));
    }
    recents.appendChild(list);
    wrapper.appendChild(recents);
  }

  return wrapper;
}

function createSpaceNode(machineId: string | null, space: SpaceSummaryDto): HTMLElement {
  const normalizedKey = `${machineId ?? 'local'}:${space.id}`;
  const node = document.createElement('article');
  node.className = 'spaces-tree-space';
  if (isSpaceCollapsed(normalizedKey)) {
    node.classList.add('collapsed');
  }

  const activeSessionCount = getSpaceSessions(machineId, space).length;
  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'spaces-tree-space-header';
  header.innerHTML = `
    <span class="spaces-tree-caret">▾</span>
    <span class="spaces-tree-space-title">${escapeHtml(space.label)}</span>
    <span class="spaces-tree-space-meta">${escapeHtml(space.kind.toUpperCase())}</span>
    ${!space.isPinned ? `<span class="spaces-tree-space-badge">${escapeHtml(t('spaces.unpinned'))}</span>` : ''}
    ${activeSessionCount > 0 ? `<span class="spaces-tree-space-count">${activeSessionCount}</span>` : ''}
  `;
  header.addEventListener('click', () => {
    toggleSpaceCollapsed(node, normalizedKey);
  });

  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = `spaces-tree-pin${space.isPinned ? ' pinned' : ''}`;
  pin.title = space.isPinned ? t('spaces.unpinSpace') : t('spaces.pinSpace');
  pin.textContent = space.isPinned ? '★' : '☆';
  pin.addEventListener('click', (event) => {
    event.stopPropagation();
    void toggleSpacePinned(machineId, space);
  });

  const headerRow = document.createElement('div');
  headerRow.className = 'spaces-tree-space-header-row';
  headerRow.append(header, pin);
  node.appendChild(headerRow);

  const body = document.createElement('div');
  body.className = 'spaces-tree-space-body';

  const path = document.createElement('div');
  path.className = 'spaces-tree-space-path';
  path.textContent = space.rootPath;
  path.title = space.rootPath;
  body.appendChild(path);

  const tools = document.createElement('div');
  tools.className = 'spaces-tree-space-tools';
  tools.appendChild(
    createActionButton(
      space.kind === 'git' ? t('spaces.newWorktree') : t('spaces.initGit'),
      () => {
        if (space.kind === 'git') {
          void promptAndCreateWorktree(machineId, space);
        } else {
          void initGit(machineId, space.id);
        }
      },
      'secondary',
    ),
  );
  tools.appendChild(
    createActionButton(t('spaces.renameSpace'), () => {
      void promptAndRenameSpace(machineId, space);
    }),
  );
  tools.appendChild(
    createActionButton(
      t('spaces.deleteSpace'),
      () => {
        void promptAndDeleteSpace(machineId, space);
      },
      'danger',
    ),
  );
  body.appendChild(tools);

  const workspaceList = document.createElement('div');
  workspaceList.className = 'spaces-tree-workspace-list';
  for (const workspace of space.workspaces) {
    workspaceList.appendChild(createWorkspaceNode(machineId, space, workspace));
  }
  body.appendChild(workspaceList);

  node.appendChild(body);
  return node;
}

function createWorkspaceNode(
  machineId: string | null,
  space: SpaceSummaryDto,
  workspace: SpaceWorkspaceDto,
): HTMLElement {
  const node = document.createElement('div');
  node.className = 'spaces-tree-workspace';

  const sessions = getWorkspaceSessions(machineId, space, workspace);
  const line = document.createElement('div');
  line.className = 'spaces-tree-workspace-line';
  line.appendChild(createTextSpan('spaces-tree-workspace-name', workspace.displayName));
  if (workspace.branch) {
    line.appendChild(createTextSpan('spaces-tree-workspace-branch', workspace.branch));
  }
  if (workspace.isMain) {
    line.appendChild(createTextSpan('spaces-tree-workspace-badge', t('spaces.mainWorkspace')));
  }
  if (workspace.isDetached) {
    line.appendChild(createTextSpan('spaces-tree-workspace-badge', t('spaces.detached')));
  }
  if (workspace.locked) {
    line.appendChild(createTextSpan('spaces-tree-workspace-badge', t('spaces.locked')));
  }
  if (workspace.prunable) {
    line.appendChild(createTextSpan('spaces-tree-workspace-badge', t('spaces.prunable')));
  }
  if (workspace.hasActiveAiSession) {
    line.appendChild(createTextSpan('spaces-tree-workspace-badge warn', t('spaces.aiBusy')));
  }
  if (workspace.hasChanges) {
    line.appendChild(
      createTextSpan('spaces-tree-workspace-badge warn', String(workspace.changeCount)),
    );
  }
  if (sessions.length > 0) {
    line.appendChild(createTextSpan('spaces-tree-workspace-badge', String(sessions.length)));
  }
  node.appendChild(line);

  const path = document.createElement('div');
  path.className = 'spaces-tree-workspace-path';
  path.textContent = workspace.path;
  path.title = workspace.path;
  node.appendChild(path);

  const actions = document.createElement('div');
  actions.className = 'spaces-tree-workspace-actions';
  actions.appendChild(createLaunchActionButton(space.id, machineId, workspace, 'terminal'));
  actions.appendChild(createLaunchActionButton(space.id, machineId, workspace, 'codex'));
  actions.appendChild(createLaunchActionButton(space.id, machineId, workspace, 'claude'));
  if (workspace.kind === 'worktree' && !workspace.isMain) {
    actions.appendChild(
      createActionButton(t('spaces.renameWorktreeShort'), () => {
        void promptAndRenameWorktree(machineId, space.id, workspace);
      }),
    );
    actions.appendChild(
      createActionButton(
        t('spaces.deleteWorktreeShort'),
        () => {
          void promptAndDeleteWorktree(machineId, space.id, workspace);
        },
        'danger',
      ),
    );
  }
  node.appendChild(actions);

  if (sessions.length > 0) {
    const pills = document.createElement('div');
    pills.className = 'spaces-tree-session-pills';
    for (const session of sessions) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `spaces-tree-session-pill${session.id === $activeSessionId.get() ? ' active' : ''}`;
      pill.textContent = getSessionDisplayName(session.session);
      pill.title = getSessionDisplayName(session.session);
      pill.addEventListener('click', () => {
        callbacks?.onSelect(session.id);
        callbacks?.onCloseSidebar();
      });
      pills.appendChild(pill);
    }
    node.appendChild(pills);
  }

  return node;
}

function createLaunchActionButton(
  spaceId: string,
  machineId: string | null,
  workspace: SpaceWorkspaceDto,
  surface: SpaceSurface,
): HTMLButtonElement {
  const label =
    surface === 'terminal'
      ? t('session.terminal')
      : surface === 'codex'
        ? t('sessionLauncher.codexTitle')
        : t('sessionLauncher.claudeTitle');

  return createActionButton(
    label,
    () => {
      void openWorkspace(machineId, spaceId, workspace, surface);
    },
    'launch',
  );
}

function createRecentNode(machineId: string | null, recent: LaunchEntry): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'spaces-tree-recent';
  button.innerHTML = `
    <span class="spaces-tree-recent-label">${escapeHtml(recent.label || recent.executable || recent.workingDirectory || t('session.terminal'))}</span>
    <span class="spaces-tree-recent-path">${escapeHtml(recent.workingDirectory || '')}</span>
  `;
  button.addEventListener('click', () => {
    void launchRecentEntry(machineId, recent);
    callbacks?.onCloseSidebar();
  });
  return button;
}

function createAdHocSection(sessions: SidebarSessionRef[]): HTMLElement {
  const section = document.createElement('section');
  section.className = 'spaces-tree-target spaces-tree-adhoc';

  const header = document.createElement('div');
  header.className = 'spaces-tree-target-header';
  header.innerHTML = `
    <span class="spaces-tree-target-label">${escapeHtml(t('spaces.adHocSessions'))}</span>
    <span class="spaces-tree-target-count">${sessions.length}</span>
  `;
  section.appendChild(header);

  const list = document.createElement('div');
  list.className = 'spaces-tree-adhoc-list';
  for (const entry of sessions) {
    const item = document.createElement('div');
    item.className = `spaces-tree-adhoc-item${entry.id === $activeSessionId.get() ? ' active' : ''}`;

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'spaces-tree-adhoc-open';
    const label = entry.machineId
      ? `${getMachineLabel(entry.machineId)} · ${getSessionDisplayName(entry.session)}`
      : getSessionDisplayName(entry.session);
    const location =
      entry.session.currentDirectory || entry.session.workspacePath || entry.session.shellType;
    openButton.innerHTML = `
      <span class="spaces-tree-adhoc-title">${escapeHtml(label)}</span>
      <span class="spaces-tree-adhoc-path">${escapeHtml(location || '')}</span>
    `;
    openButton.addEventListener('click', () => {
      callbacks?.onSelect(entry.id);
      callbacks?.onCloseSidebar();
    });
    item.appendChild(openButton);

    if (location) {
      const tools = document.createElement('div');
      tools.className = 'spaces-tree-adhoc-actions';
      tools.appendChild(
        createActionButton(t('spaces.saveSessionAsSpace'), () => {
          void saveSessionAsSpace(entry);
        }),
      );
      item.appendChild(tools);
    }

    list.appendChild(item);
  }
  section.appendChild(list);
  return section;
}

function getWorkspaceSessions(
  machineId: string | null,
  space: SpaceSummaryDto,
  workspace: SpaceWorkspaceDto,
): SidebarSessionRef[] {
  const normalizedWorkspacePath = normalizeOptionalPath(workspace.path);
  return getAllSidebarSessions()
    .filter((entry) => sessionBelongsToSpace(entry, machineId, space))
    .filter(
      (entry) =>
        normalizedWorkspacePath &&
        normalizeOptionalPath(entry.session.workspacePath || entry.session.currentDirectory) ===
          normalizedWorkspacePath,
    )
    .sort((left, right) =>
      getSessionDisplayName(left.session).localeCompare(getSessionDisplayName(right.session)),
    );
}

function getSpaceSessions(machineId: string | null, space: SpaceSummaryDto): SidebarSessionRef[] {
  return getAllSidebarSessions().filter((entry) => sessionBelongsToSpace(entry, machineId, space));
}

function sessionBelongsToSpace(
  entry: SidebarSessionRef,
  machineId: string | null,
  space: SpaceSummaryDto,
): boolean {
  if (entry.machineId !== machineId) {
    return false;
  }

  if (entry.session.spaceId === space.id) {
    return true;
  }

  const sessionPath = normalizeOptionalPath(
    entry.session.workspacePath || entry.session.currentDirectory,
  );
  if (!sessionPath) {
    return false;
  }

  return space.workspaces.some(
    (workspace) => normalizeOptionalPath(workspace.path) === sessionPath,
  );
}

function getMachineLabel(machineId: string): string {
  return cachedSections.find((section) => section.machineId === machineId)?.label || machineId;
}

function matchesSpaceSearch(space: SpaceSummaryDto): boolean {
  return matchesSearchTokens([space.label, space.rootPath, space.importedPath, space.kind]);
}

function matchesWorkspaceSearch(workspace: SpaceWorkspaceDto): boolean {
  return matchesSearchTokens([
    workspace.displayName,
    workspace.path,
    workspace.branch,
    workspace.isDetached ? t('spaces.detached') : '',
    workspace.locked ? t('spaces.locked') : '',
    workspace.prunable ? t('spaces.prunable') : '',
  ]);
}

function matchesRecentSearch(recent: LaunchEntry): boolean {
  if (!searchValue) {
    return true;
  }

  return matchesSearchTokens([
    recent.label,
    recent.executable,
    recent.workingDirectory,
    recent.commandLine,
  ]);
}

function matchesAdHocSearch(entry: SidebarSessionRef): boolean {
  if (!searchValue) {
    return true;
  }

  return matchesSearchTokens([
    getSessionDisplayName(entry.session),
    entry.session.currentDirectory,
    entry.session.workspacePath,
    entry.session.shellType,
    entry.machineId ? getMachineLabel(entry.machineId) : '',
  ]);
}

function matchesSearchTokens(values: Array<string | null | undefined>): boolean {
  if (!searchValue) {
    return true;
  }

  return values.some((value) => value?.toLowerCase().includes(searchValue));
}

function initializeSearchControls(): void {
  if (searchBound) {
    return;
  }

  const filterInput = dom.sessionFilterInput;
  const filterClear = dom.sessionFilterClear;
  if (!filterInput || !filterClear) {
    return;
  }

  filterInput.addEventListener('input', () => {
    searchValue = normalizeSearchValue(filterInput.value);
    syncSearchControls();
    renderSidebarTree();
    updateEmptyState();
  });

  filterInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (searchValue) {
        searchValue = '';
        syncSearchControls();
        renderSidebarTree();
        updateEmptyState();
      } else {
        filterInput.blur();
      }
    }
  });

  filterClear.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    searchValue = '';
    syncSearchControls();
    renderSidebarTree();
    updateEmptyState();
    filterInput.focus();
  });

  searchBound = true;
}

function syncSearchControls(): void {
  if (dom.sessionFilterBar) {
    dom.sessionFilterBar.hidden = false;
  }

  if (dom.sessionFilterInput) {
    dom.sessionFilterInput.value = searchValue;
    dom.sessionFilterInput.placeholder = t('spaces.searchPlaceholder');
    dom.sessionFilterInput.setAttribute('aria-label', t('spaces.searchPlaceholder'));
  }

  if (dom.sessionFilterClear) {
    dom.sessionFilterClear.hidden = searchValue.length === 0;
    dom.sessionFilterClear.title = t('spaces.clearSearch');
    dom.sessionFilterClear.setAttribute('aria-label', t('spaces.clearSearch'));
  }
}

async function promptAndImportSpace(
  machineId: string | null,
  initialPath?: string | null,
  initialLabel?: string | null,
): Promise<void> {
  const request = await showImportSpaceDialog({
    machineId,
    ...(initialPath !== undefined ? { initialPath } : {}),
    ...(initialLabel !== undefined ? { initialLabel } : {}),
  });
  if (!request) {
    return;
  }

  try {
    if (machineId) {
      await importHubSpace(machineId, request);
    } else {
      await importLocalSpace(request);
    }
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
    invalidateSidebarSpacesTree();
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: t('spaces.gitInitFailed'),
    });
  }
}

async function promptAndCreateWorktree(
  machineId: string | null,
  space: SpaceSummaryDto,
): Promise<void> {
  const request = await showCreateWorktreeDialog({ machineId, space });
  if (!request) {
    return;
  }

  try {
    if (machineId) {
      await createHubWorktree(machineId, space.id, request);
    } else {
      await createLocalWorktree(space.id, request);
    }
    invalidateSidebarSpacesTree();
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: t('spaces.worktreeCreateFailed'),
    });
  }
}

async function promptAndRenameSpace(
  machineId: string | null,
  space: SpaceSummaryDto,
): Promise<void> {
  const nextName = await showTextPrompt({
    title: t('spaces.renameSpaceTitle'),
    confirmLabel: t('spaces.renameSpace'),
    placeholder: t('spaces.spaceNamePlaceholder'),
    initialValue: space.label,
    validate: (value) => (value.trim() ? null : t('spaces.spaceNameRequired')),
  });
  if (!nextName) {
    return;
  }

  try {
    if (machineId) {
      await updateHubSpace(machineId, space.id, { label: nextName.trim() });
    } else {
      await updateLocalSpace(space.id, { label: nextName.trim() });
    }
    invalidateSidebarSpacesTree();
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: t('spaces.renameSpaceFailed'),
    });
  }
}

async function promptAndDeleteSpace(
  machineId: string | null,
  space: SpaceSummaryDto,
): Promise<void> {
  const activeSessionCount = getSpaceSessions(machineId, space).length;
  const message =
    activeSessionCount > 0
      ? t('spaces.deleteSpaceActiveSessions').replace('{name}', space.label)
      : t('spaces.deleteSpaceConfirm').replace('{name}', space.label);
  const confirmed = await showConfirm(message, {
    title: t('spaces.deleteSpaceTitle'),
    danger: true,
    confirmLabel: t('spaces.deleteSpace'),
  });
  if (!confirmed) {
    return;
  }

  try {
    if (machineId) {
      await deleteHubSpace(machineId, space.id);
    } else {
      await deleteLocalSpace(space.id);
    }
    invalidateSidebarSpacesTree();
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: t('spaces.deleteSpaceFailed'),
    });
  }
}

async function promptAndRenameWorktree(
  machineId: string | null,
  spaceId: string,
  workspace: SpaceWorkspaceDto,
): Promise<void> {
  const nextName = await showTextPrompt({
    title: t('spaces.renameWorktree'),
    confirmLabel: t('spaces.renameWorktreeShort'),
    initialValue: workspace.displayName,
    validate: (value) => (value.trim() ? null : t('spaces.worktreeNameRequired')),
  });
  if (!nextName) {
    return;
  }

  try {
    if (machineId) {
      await updateHubWorkspace(machineId, spaceId, workspace.key, { label: nextName.trim() });
    } else {
      await updateLocalWorkspace(spaceId, workspace.key, { label: nextName.trim() });
    }
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
  workspace: SpaceWorkspaceDto,
): Promise<void> {
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
      danger: true,
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
        danger: true,
      },
    );
    if (!dirtyConfirmed) {
      return;
    }

    const finalConfirmed = await showConfirm(
      t('spaces.deleteWorktreeDirtyFinalConfirm').replace('{name}', workspace.displayName),
      {
        title: t('spaces.deleteWorktreeDirtyFinalTitle'),
        danger: true,
      },
    );
    if (!finalConfirmed) {
      return;
    }

    force = true;
  }

  try {
    if (machineId) {
      await deleteHubWorktree(machineId, spaceId, workspace.key, { force });
    } else {
      await deleteLocalWorktree(spaceId, workspace.key, { force });
    }
    invalidateSidebarSpacesTree();
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: t('spaces.deleteWorktreeFailed'),
    });
  }
}

async function openWorkspace(
  machineId: string | null,
  spaceId: string,
  workspace: SpaceWorkspaceDto,
  surface: SpaceSurface,
): Promise<void> {
  const launched = await launchSpaceWorkspace(machineId, spaceId, workspace, surface);
  if (launched) {
    callbacks?.onCloseSidebar();
  }
}

async function saveSessionAsSpace(entry: SidebarSessionRef): Promise<void> {
  const path = entry.session.workspacePath || entry.session.currentDirectory;
  if (!path) {
    await showAlert(t('spaces.noPathForSession'), {
      title: t('spaces.saveSessionAsSpaceTitle'),
    });
    return;
  }

  await promptAndImportSpace(entry.machineId, path, getSessionDisplayName(entry.session));
}

function createActionButton(
  label: string,
  handler: () => void,
  tone: 'default' | 'secondary' | 'danger' | 'launch' = 'default',
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `spaces-tree-action spaces-tree-action-${tone}`;
  button.textContent = label;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    handler();
  });
  return button;
}

function createTextSpan(className: string, value: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = value;
  return span;
}

function isSpaceCollapsed(key: string): boolean {
  return localStorage.getItem(`${SPACE_COLLAPSE_PREFIX}${key}`) === 'true';
}

function toggleSpaceCollapsed(node: HTMLElement, key: string): void {
  const collapsed = node.classList.toggle('collapsed');
  localStorage.setItem(`${SPACE_COLLAPSE_PREFIX}${key}`, String(collapsed));
}

async function toggleSpacePinned(machineId: string | null, space: SpaceSummaryDto): Promise<void> {
  try {
    if (machineId) {
      await updateHubSpace(machineId, space.id, { isPinned: !space.isPinned });
    } else {
      await updateLocalSpace(space.id, { isPinned: !space.isPinned });
    }
    invalidateSidebarSpacesTree();
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: space.isPinned ? t('spaces.unpinSpace') : t('spaces.pinSpace'),
    });
  }
}

function normalizeSearchValue(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOptionalPath(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
