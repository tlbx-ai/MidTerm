import type { LaunchEntry, Session, SpaceSummaryDto, SpaceWorkspaceDto } from '../../api/types';
import { icon } from '../../constants';
import { dom } from '../../state';
import { $activeSessionId, $currentSettings, $sessionList, $settingsOpen } from '../../stores';
import { getLaunchableHubMachines, getHubSidebarSections } from '../hub/runtime';
import { t } from '../i18n';
import { addProcessStateListener, getForegroundInfo } from '../process';
import {
  createHubWorktree,
  createLocalWorktree,
  deleteHubSpace,
  deleteHubWorktree,
  deleteLocalSpace,
  deleteLocalWorktree,
  fetchHubSpaces,
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
import { launchSpaceWorkspace, type SpaceSurface } from '../spaces/runtime';
import { showAlert, showConfirm, showTextPrompt } from '../../utils/dialog';
import {
  createSessionFilterController,
  type SessionFilterControllerElements,
} from './sessionFilterController';
import { pruneHeatSessions, registerHeatCanvas, unregisterHeatCanvas } from './heatIndicator';
import { isAdHocSession } from './spacesTreeSidebarLogic';
import {
  getSessionDisplayInfo,
  getSessionDisplayName as getLegacySessionDisplayName,
} from './sessionList';

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

interface SidebarSpaceSection {
  id: string;
  label: string;
  machineId: string | null;
  spaces: SpaceSummaryDto[];
}

interface SidebarSessionRef {
  id: string;
  machineId: string | null;
  session: Session;
}

interface PopoverAction {
  label: string;
  tone?: 'default' | 'danger';
  run: () => void | Promise<void>;
}

let callbacks: SessionListCallbacks | null = null;
let cachedSections: SidebarSpaceSection[] = [];
let loadPromise: Promise<void> | null = null;
let lastLoadedAt = 0;
let loadToken = 0;
let queuedRenderFrameId: number | null = null;
let actionPopoverEl: HTMLDivElement | null = null;
let chooserPopoverEl: HTMLDivElement | null = null;

const SESSION_FILTER_STORAGE_KEY = 'midterm.sidebar.sessionFilter';
const SPACE_EXPANDED_PREFIX = 'midterm.sidebar.spaceExpanded.';
const TREE_TTL_MS = 15_000;

export function getSessionDisplayName(session: Session): string {
  return getLegacySessionDisplayName(session);
}

function loadStoredSessionFilter(): string {
  try {
    return (localStorage.getItem(SESSION_FILTER_STORAGE_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

function persistSessionFilter(value: string): void {
  try {
    if (value === '') {
      localStorage.removeItem(SESSION_FILTER_STORAGE_KEY);
    } else {
      localStorage.setItem(SESSION_FILTER_STORAGE_KEY, value);
    }
  } catch {
    // Ignore localStorage failures.
  }
}

function isSidebarSessionFilterEnabled(): boolean {
  return $currentSettings.get()?.showSidebarSessionFilter === true;
}

const sessionFilterController = createSessionFilterController({
  getElements: () =>
    ({
      filterBar: dom.sessionFilterBar,
      filterInput: dom.sessionFilterInput,
      filterClear: dom.sessionFilterClear,
    }) satisfies SessionFilterControllerElements,
  isEnabled: isSidebarSessionFilterEnabled,
  areSettingsLoaded: () => $currentSettings.get() !== null,
  loadStoredFilter: loadStoredSessionFilter,
  persistFilter: persistSessionFilter,
  render: () => {
    renderSessionList();
    updateEmptyState();
  },
  translate: t,
});

export function initializeSessionList(): void {
  ensurePopovers();
  addProcessStateListener(queueSidebarTreeRender);
  sessionFilterController.initialize();
  syncSearchControls();
  document.addEventListener('click', handleGlobalPopoverClick);
  window.addEventListener('resize', closePopovers);
  window.addEventListener('orientationchange', closePopovers);
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
  sessionFilterController.applySettingChange();
  syncSearchControls();
}

export function renderSessionList(): void {
  if (!dom.sessionList) {
    return;
  }

  if (shouldRefreshSidebarTree()) {
    void refreshSidebarSpacesTree();
  }

  closePopovers();
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

  const hasSpaces = getVisibleSpaceSections().some((section) => section.spaces.length > 0);
  const hasSessions = getAllSidebarSessions().length > 0;
  dom.emptyState.classList.toggle('hidden', hasSpaces || hasSessions);
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
  const [localSpaces, remoteSections] = await Promise.all([
    fetchLocalSpaces({ pinnedOnly: true }).catch(() => []),
    Promise.all(
      machines.map(async (machine) => ({
        id: machine.machine.id,
        label: machine.machine.name,
        machineId: machine.machine.id,
        spaces: await fetchHubSpaces(machine.machine.id, { pinnedOnly: true }).catch(() => []),
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
  pruneHeatSessions(getAllSidebarSessions().map((entry) => entry.id));
  host.querySelectorAll<HTMLElement>('.session-item[data-session-id]').forEach((item) => {
    const sessionId = item.dataset.sessionId;
    if (sessionId) {
      unregisterHeatCanvas(sessionId);
    }
  });
  host.replaceChildren();

  const adHocSessions = getAdHocSessions();
  if (adHocSessions.length > 0) {
    host.appendChild(createAdHocSection(adHocSessions));
  }

  for (const section of getVisibleSpaceSections()) {
    host.appendChild(createSpaceTargetSection(section));
  }

  if (host.childElementCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'spaces-sidebar-empty';
    empty.textContent = getSearchValue() ? t('spaces.noSearchMatches') : t('spaces.sidebarEmpty');
    host.appendChild(empty);
  }
}

function getVisibleSpaceSections(): SidebarSpaceSection[] {
  return cachedSections
    .map((section) => filterSection(section))
    .filter((section) => section.spaces.length > 0);
}

function filterSection(section: SidebarSpaceSection): SidebarSpaceSection {
  return {
    ...section,
    spaces: section.spaces
      .map((space) => filterSpace(section.machineId, space))
      .filter((space): space is SpaceSummaryDto => space !== null),
  };
}

function filterSpace(machineId: string | null, space: SpaceSummaryDto): SpaceSummaryDto | null {
  if (!space.isPinned) {
    return null;
  }

  const searchValue = getSearchValue();
  if (!searchValue || matchesSpaceSearch(space)) {
    return space;
  }

  const matchingWorkspaces = space.workspaces.filter((workspace) =>
    matchesWorkspaceSearch(machineId, space, workspace),
  );
  const matchingSessions = getSpaceSessions(machineId, space).some(matchesSidebarSessionSearch);
  if (!matchingSessions && matchingWorkspaces.length === 0) {
    return null;
  }

  return {
    ...space,
    workspaces: matchingWorkspaces.length > 0 ? matchingWorkspaces : space.workspaces,
  };
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
    .filter((entry) => isAdHocSession(entry.session))
    .filter(matchesSidebarSessionSearch);
}

function createSpaceTargetSection(section: SidebarSpaceSection): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.className = 'spaces-tree-target';

  const header = document.createElement('div');
  header.className = 'spaces-tree-target-header';
  header.innerHTML = `<span class="spaces-tree-target-label">${escapeHtml(section.label)}</span>`;
  wrapper.appendChild(header);

  const list = document.createElement('div');
  list.className = 'spaces-tree-space-list';
  for (const space of section.spaces) {
    list.appendChild(createSpaceNode(section.machineId, space));
  }
  wrapper.appendChild(list);

  return wrapper;
}

function createSpaceNode(machineId: string | null, space: SpaceSummaryDto): HTMLElement {
  const sessions = getVisibleSpaceSessions(machineId, space);
  const expanded = isSpaceExpanded(machineId, space, sessions.length > 0);

  const node = document.createElement('article');
  node.className = `spaces-tree-space${expanded ? ' expanded' : ''}`;

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'spaces-tree-space-header';
  header.addEventListener('click', () => {
    toggleSpaceExpanded(machineId, space.id, expanded);
  });

  const identity = document.createElement('div');
  identity.className = 'spaces-tree-space-identity';
  identity.appendChild(createTextSpan('spaces-tree-space-title', space.displayName));

  const path = document.createElement('div');
  path.className = 'spaces-tree-space-path';
  path.textContent = space.rootPath;
  path.title = space.rootPath;
  identity.appendChild(path);
  header.appendChild(identity);

  const meta = document.createElement('div');
  meta.className = 'spaces-tree-space-meta';
  if (sessions.length > 0) {
    meta.appendChild(createTextSpan('spaces-tree-space-count', String(sessions.length)));
  }
  meta.appendChild(createChevron(expanded));
  header.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'spaces-tree-space-actions';

  const pinButton = document.createElement('button');
  pinButton.type = 'button';
  pinButton.className = `spaces-tree-pin spaces-tree-inline-action${space.isPinned ? ' pinned' : ''}`;
  pinButton.title = space.isPinned ? t('spaces.unpinSpace') : t('spaces.pinSpace');
  pinButton.setAttribute('aria-label', pinButton.title);
  pinButton.textContent = space.isPinned ? '★' : '☆';
  pinButton.addEventListener('click', (event) => {
    event.stopPropagation();
    void toggleSpacePinned(machineId, space);
  });
  actions.appendChild(pinButton);

  const menuButton = document.createElement('button');
  menuButton.type = 'button';
  menuButton.className = 'spaces-tree-overflow spaces-tree-inline-action';
  menuButton.title = t('session.actions');
  menuButton.setAttribute('aria-label', t('session.actions'));
  menuButton.textContent = '⋯';
  menuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    openActionPopover(menuButton, buildSpaceActions(machineId, space));
  });
  actions.appendChild(menuButton);
  header.appendChild(actions);

  node.appendChild(header);

  if (!expanded) {
    return node;
  }

  const workspaceList = document.createElement('div');
  workspaceList.className = 'spaces-tree-workspace-list';
  for (const workspace of getVisibleSpaceWorkspaces(machineId, space)) {
    workspaceList.appendChild(createWorkspaceNode(machineId, space, workspace));
  }
  node.appendChild(workspaceList);
  return node;
}

function createWorkspaceNode(
  machineId: string | null,
  space: SpaceSummaryDto,
  workspace: SpaceWorkspaceDto,
): HTMLElement {
  const sessions = getWorkspaceSessions(machineId, space, workspace).filter(
    matchesSidebarSessionSearch,
  );
  const block = document.createElement('section');
  block.className = 'spaces-tree-workspace-block';

  const row = document.createElement('div');
  row.className = 'spaces-tree-workspace';

  const mainButton = document.createElement('button');
  mainButton.type = 'button';
  mainButton.className = 'spaces-tree-workspace-open';
  mainButton.disabled = sessions.length === 0;
  if (sessions.length > 0) {
    mainButton.addEventListener('click', () => {
      const activeSession =
        sessions.find((session) => session.id === $activeSessionId.get()) ?? sessions[0];
      if (!activeSession) {
        return;
      }
      callbacks?.onSelect(activeSession.id);
      callbacks?.onCloseSidebar();
    });
  }

  const line = document.createElement('div');
  line.className = 'spaces-tree-workspace-line';
  line.appendChild(createTextSpan('spaces-tree-workspace-name', workspace.displayName));
  if (workspace.branch) {
    line.appendChild(createTextSpan('spaces-tree-workspace-branch', workspace.branch));
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
  if (workspace.hasChanges) {
    line.appendChild(
      createTextSpan('spaces-tree-workspace-badge warn', String(workspace.changeCount)),
    );
  }
  if (workspace.hasActiveAiSession) {
    line.appendChild(createTextSpan('spaces-tree-workspace-badge warn', t('spaces.aiBusy')));
  }
  mainButton.appendChild(line);

  const path = document.createElement('div');
  path.className = 'spaces-tree-workspace-path';
  path.textContent = workspace.path;
  path.title = workspace.path;
  mainButton.appendChild(path);
  row.appendChild(mainButton);

  const actions = document.createElement('div');
  actions.className = 'spaces-tree-workspace-actions';

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'spaces-tree-add spaces-tree-inline-action';
  addButton.title = t('spaces.newSession');
  addButton.setAttribute('aria-label', t('spaces.newSession'));
  addButton.textContent = '+';
  addButton.addEventListener('click', (event) => {
    event.stopPropagation();
    openSurfaceChooser(addButton, machineId, space, workspace);
  });
  actions.appendChild(addButton);

  if (canManageWorkspace(space, workspace)) {
    const menuButton = document.createElement('button');
    menuButton.type = 'button';
    menuButton.className = 'spaces-tree-overflow spaces-tree-inline-action';
    menuButton.title = t('session.actions');
    menuButton.setAttribute('aria-label', t('session.actions'));
    menuButton.textContent = '⋯';
    menuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      openActionPopover(menuButton, buildWorkspaceActions(machineId, space, workspace, sessions));
    });
    actions.appendChild(menuButton);
  }

  row.appendChild(actions);
  block.appendChild(row);

  if (sessions.length > 0) {
    const sessionList = document.createElement('div');
    sessionList.className = 'spaces-tree-workspace-session-list';
    for (const entry of sessions) {
      sessionList.appendChild(createSidebarSessionNode(entry));
    }
    block.appendChild(sessionList);
  }

  return block;
}

function createSidebarSessionNode(entry: SidebarSessionRef): HTMLElement {
  const item = document.createElement('div');
  item.className = `session-item two-line spaces-tree-session-item${entry.id === $activeSessionId.get() ? ' active' : ''}`;
  item.dataset.sessionId = entry.id;
  item.setAttribute('aria-current', entry.id === $activeSessionId.get() ? 'true' : 'false');
  item.addEventListener('click', () => {
    callbacks?.onSelect(entry.id);
    callbacks?.onCloseSidebar();
  });

  const heatIndicator = document.createElement('div');
  heatIndicator.className = 'heat-canvas';
  registerHeatCanvas(entry.id, heatIndicator);
  item.appendChild(heatIndicator);

  const info = document.createElement('div');
  info.className = 'session-info';
  const displayInfo = getSessionDisplayInfo(entry.session);

  const titleRow = document.createElement('div');
  titleRow.className = 'session-title-row';

  const title = document.createElement('div');
  title.className = 'session-title';
  title.textContent = displayInfo.primary;
  titleRow.appendChild(title);

  if (displayInfo.secondary) {
    const subtitle = document.createElement('div');
    subtitle.className = 'session-subtitle';
    subtitle.textContent = displayInfo.secondary;
    titleRow.appendChild(subtitle);
  }

  info.appendChild(titleRow);

  const processInfo = document.createElement('div');
  processInfo.className = 'session-process-info';
  processInfo.appendChild(createForegroundIndicator(entry));
  info.appendChild(processInfo);

  item.appendChild(info);
  item.appendChild(createSidebarSessionActions(entry));
  return item;
}

function createSidebarSessionActions(entry: SidebarSessionRef): HTMLDivElement {
  const actions = document.createElement('div');
  actions.className = 'session-actions';
  actions.id = `session-actions-${entry.id}`;
  actions.setAttribute('role', 'menu');

  const closeButton = document.createElement('button');
  closeButton.className = 'session-close';
  closeButton.setAttribute('role', 'menuitem');
  closeButton.title = t('session.close');
  closeButton.setAttribute('aria-label', t('session.close'));
  closeButton.innerHTML = `
    <span class="session-action-icon">${icon('close')}</span>
    <span class="session-action-label">${escapeHtml(t('session.close'))}</span>
  `;
  closeButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    callbacks?.onDelete(entry.id);
  });

  actions.appendChild(closeButton);
  return actions;
}

function createAdHocSection(sessions: SidebarSessionRef[]): HTMLElement {
  const section = document.createElement('section');
  section.className = 'spaces-tree-target spaces-tree-adhoc';

  const header = document.createElement('div');
  header.className = 'spaces-tree-target-header';
  header.innerHTML = `<span class="spaces-tree-target-label">${escapeHtml(t('spaces.adHocSessions'))}</span>`;
  section.appendChild(header);

  const list = document.createElement('div');
  list.className = 'spaces-tree-adhoc-list';
  for (const entry of sessions) {
    const item = document.createElement('div');
    item.className = 'spaces-tree-adhoc-item';
    item.appendChild(createSidebarSessionNode(entry));

    const path = entry.session.workspacePath || entry.session.currentDirectory;
    if (path) {
      const tools = document.createElement('div');
      tools.className = 'spaces-tree-adhoc-actions';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'spaces-tree-add spaces-tree-inline-action';
      button.textContent = '+';
      button.title = t('spaces.saveSessionAsSpace');
      button.setAttribute('aria-label', t('spaces.saveSessionAsSpace'));
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        void saveSessionAsSpace(entry);
      });
      tools.appendChild(button);
      item.appendChild(tools);
    }

    list.appendChild(item);
  }

  section.appendChild(list);
  return section;
}

function getForegroundProcessLabel(entry: SidebarSessionRef): string {
  const foreground = getForegroundInfo(entry.id);
  return (
    foreground.displayName?.trim() ||
    foreground.commandLine?.trim() ||
    foreground.name?.trim() ||
    entry.session.shellType ||
    t('session.terminal')
  );
}

function createForegroundIndicator(entry: SidebarSessionRef): HTMLElement {
  const foreground = getForegroundInfo(entry.id);
  const cwd = foreground.cwd || entry.session.currentDirectory || entry.session.workspacePath || '';
  const process = getForegroundProcessLabel(entry);

  const container = document.createElement('span');
  container.className = 'session-foreground';
  container.title = cwd ? `${cwd}\n${process}` : process;

  if (cwd) {
    const cwdSpan = document.createElement('span');
    cwdSpan.className = 'fg-cwd';
    cwdSpan.textContent = cwd;
    container.appendChild(cwdSpan);

    const separator = document.createElement('span');
    separator.className = 'fg-separator';
    separator.textContent = '>';
    container.appendChild(separator);
  }

  const processSpan = document.createElement('span');
  processSpan.className = 'fg-process';
  processSpan.textContent = process;
  container.appendChild(processSpan);
  return container;
}

function getVisibleSpaceSessions(
  machineId: string | null,
  space: SpaceSummaryDto,
): SidebarSessionRef[] {
  return getSpaceSessions(machineId, space)
    .filter(matchesSidebarSessionSearch)
    .sort((left, right) =>
      getSessionDisplayName(left.session).localeCompare(getSessionDisplayName(right.session)),
    );
}

function getVisibleSpaceWorkspaces(
  machineId: string | null,
  space: SpaceSummaryDto,
): SpaceWorkspaceDto[] {
  if (!getSearchValue()) {
    return space.workspaces;
  }

  return space.workspaces.filter((workspace) =>
    matchesWorkspaceSearch(machineId, space, workspace),
  );
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

  if (isAdHocSession(entry.session)) {
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
  return matchesSearchTokens([space.displayName, space.rootPath, space.importedPath, space.kind]);
}

function matchesWorkspaceSearch(
  machineId: string | null,
  space: SpaceSummaryDto,
  workspace: SpaceWorkspaceDto,
): boolean {
  if (
    getWorkspaceSessions(machineId, space, workspace).some((entry) =>
      matchesSidebarSessionSearch(entry),
    )
  ) {
    return true;
  }

  return matchesSearchTokens([
    workspace.displayName,
    workspace.path,
    workspace.branch,
    workspace.isDetached ? t('spaces.detached') : '',
    workspace.locked ? t('spaces.locked') : '',
    workspace.prunable ? t('spaces.prunable') : '',
  ]);
}

function matchesSidebarSessionSearch(entry: SidebarSessionRef): boolean {
  const foreground = getForegroundInfo(entry.id);
  return matchesSearchTokens([
    getSessionDisplayName(entry.session),
    entry.session.name,
    entry.session.terminalTitle,
    entry.session.currentDirectory,
    entry.session.workspacePath,
    entry.session.shellType,
    foreground.cwd,
    foreground.name,
    foreground.displayName,
    foreground.commandLine,
    entry.machineId ? getMachineLabel(entry.machineId) : '',
  ]);
}

function matchesSearchTokens(values: Array<string | null | undefined>): boolean {
  const searchValue = getSearchValue();
  if (!searchValue) {
    return true;
  }

  return values.some((value) => value?.toLowerCase().includes(searchValue));
}

function getSearchValue(): string {
  return normalizeSearchValue(sessionFilterController.getFilterValue());
}

function syncSearchControls(): void {
  if (dom.sessionFilterInput) {
    dom.sessionFilterInput.placeholder = t('spaces.searchPlaceholder');
    dom.sessionFilterInput.setAttribute('aria-label', t('spaces.searchPlaceholder'));
  }

  if (dom.sessionFilterClear) {
    dom.sessionFilterClear.title = t('spaces.clearSearch');
    dom.sessionFilterClear.setAttribute('aria-label', t('spaces.clearSearch'));
  }
}

async function promptAndImportSpace(
  machineId: string | null,
  initialPath?: string | null,
): Promise<void> {
  const request = await showImportSpaceDialog({
    machineId,
    ...(initialPath !== undefined ? { initialPath } : {}),
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

async function promptAndCreateWorktree(machineId: string | null, spaceId: string): Promise<void> {
  const space = cachedSections
    .find((section) => section.machineId === machineId)
    ?.spaces.find((candidate) => candidate.id === spaceId);
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
  workspace: SpaceWorkspaceDto,
): Promise<void> {
  const nextName = await showTextPrompt({
    title: t('spaces.renameWorktree'),
    initialValue: workspace.isMain ? '' : workspace.displayName,
  });
  if (nextName === null) {
    return;
  }

  try {
    const request = { label: nextName.trim() || null };
    if (machineId) {
      await updateHubWorkspace(machineId, spaceId, workspace.key, request);
    } else {
      await updateLocalWorkspace(spaceId, workspace.key, request);
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
  sessions: SidebarSessionRef[],
): Promise<void> {
  if (sessions.length > 0) {
    await showAlert(t('spaces.deleteWorktreeActiveSessions'), {
      title: t('spaces.deleteWorktreeBlockedTitle'),
    });
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
  } else {
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

async function promptAndDeleteSpace(
  machineId: string | null,
  space: SpaceSummaryDto,
): Promise<void> {
  const hasActiveSessions = getSpaceSessions(machineId, space).length > 0;
  const confirmed = await showConfirm(
    (hasActiveSessions
      ? t('spaces.deleteSpaceActiveSessions')
      : t('spaces.deleteSpaceConfirm')
    ).replace('{name}', space.displayName),
    {
      title: t('spaces.deleteSpaceTitle'),
      danger: true,
    },
  );
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

async function openWorkspace(
  machineId: string | null,
  spaceId: string,
  workspace: SpaceWorkspaceDto,
  surface: SpaceSurface,
): Promise<void> {
  closePopovers();
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

  await promptAndImportSpace(entry.machineId, path);
}

function buildSpaceActions(machineId: string | null, space: SpaceSummaryDto): PopoverAction[] {
  const actions: PopoverAction[] = [];

  if (space.canCreateWorktree) {
    actions.push({
      label: t('spaces.newWorktree'),
      run: () => {
        void promptAndCreateWorktree(machineId, space.id);
      },
    });
  } else if (space.canInitGit) {
    actions.push({
      label: t('spaces.initGit'),
      run: () => {
        void initGit(machineId, space.id);
      },
    });
  }

  actions.push({
    label: t('spaces.deleteSpace'),
    tone: 'danger',
    run: () => {
      void promptAndDeleteSpace(machineId, space);
    },
  });

  return actions;
}

function buildWorkspaceActions(
  machineId: string | null,
  space: SpaceSummaryDto,
  workspace: SpaceWorkspaceDto,
  sessions: SidebarSessionRef[],
): PopoverAction[] {
  return [
    {
      label: t('spaces.renameWorktreeShort'),
      run: () => {
        void promptAndRenameWorktree(machineId, space.id, workspace);
      },
    },
    {
      label: t('spaces.deleteWorktreeShort'),
      tone: 'danger',
      run: () => {
        void promptAndDeleteWorktree(machineId, space.id, workspace, sessions);
      },
    },
  ];
}

function canManageWorkspace(space: SpaceSummaryDto, workspace: SpaceWorkspaceDto): boolean {
  return space.kind === 'git' && !workspace.isMain;
}

function ensurePopovers(): void {
  if (!actionPopoverEl) {
    actionPopoverEl = document.createElement('div');
    actionPopoverEl.className = 'manager-bar-action-popover spaces-tree-popover hidden';
    document.body.appendChild(actionPopoverEl);
  }

  if (!chooserPopoverEl) {
    chooserPopoverEl = document.createElement('div');
    chooserPopoverEl.className = 'manager-bar-action-popover spaces-tree-popover hidden';
    document.body.appendChild(chooserPopoverEl);
  }
}

function openActionPopover(trigger: HTMLElement, actions: PopoverAction[]): void {
  if (!actionPopoverEl) {
    return;
  }

  chooserPopoverEl?.classList.add('hidden');
  actionPopoverEl.replaceChildren();
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `manager-bar-action-popover-btn${action.tone === 'danger' ? ' manager-bar-action-popover-delete' : ' manager-bar-action-popover-edit'}`;
    button.textContent = action.label;
    button.addEventListener('click', () => {
      closePopovers();
      void action.run();
    });
    actionPopoverEl.appendChild(button);
  }

  positionPopover(actionPopoverEl, trigger);
}

function openSurfaceChooser(
  trigger: HTMLElement,
  machineId: string | null,
  space: SpaceSummaryDto,
  workspace: SpaceWorkspaceDto,
): void {
  if (!chooserPopoverEl) {
    return;
  }

  actionPopoverEl?.classList.add('hidden');
  chooserPopoverEl.replaceChildren();

  for (const surface of ['terminal', 'codex', 'claude'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'manager-bar-action-popover-btn manager-bar-action-popover-edit';
    button.textContent = t(
      surface === 'terminal'
        ? 'sessionLauncher.startTerminal'
        : surface === 'codex'
          ? 'sessionLauncher.startCodex'
          : 'sessionLauncher.startClaude',
    );
    button.addEventListener('click', () => {
      void openWorkspace(machineId, space.id, workspace, surface);
    });
    chooserPopoverEl.appendChild(button);
  }

  positionPopover(chooserPopoverEl, trigger);
}

function positionPopover(popover: HTMLElement, trigger: HTMLElement): void {
  popover.classList.remove('hidden');
  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const gap = 6;
  const viewportPadding = 8;
  const openUp =
    window.innerHeight - triggerRect.bottom < popoverRect.height &&
    triggerRect.top > popoverRect.height;
  const top = openUp ? triggerRect.top - popoverRect.height - gap : triggerRect.bottom + gap;
  const left = Math.min(
    Math.max(viewportPadding, triggerRect.right - popoverRect.width),
    window.innerWidth - viewportPadding - popoverRect.width,
  );

  popover.style.top = `${Math.round(Math.max(viewportPadding, top))}px`;
  popover.style.left = `${Math.round(left)}px`;
}

function closePopovers(): void {
  actionPopoverEl?.classList.add('hidden');
  chooserPopoverEl?.classList.add('hidden');
}

function handleGlobalPopoverClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest('.spaces-tree-popover') || target?.closest('.spaces-tree-inline-action')) {
    return;
  }

  closePopovers();
}

function isSpaceExpanded(
  machineId: string | null,
  space: SpaceSummaryDto,
  hasSessions: boolean,
): boolean {
  if (getSearchValue()) {
    return true;
  }

  const stored = localStorage.getItem(
    `${SPACE_EXPANDED_PREFIX}${getSpaceStorageKey(machineId, space.id)}`,
  );
  if (stored === 'true') {
    return true;
  }

  if (stored === 'false') {
    return false;
  }

  return hasSessions;
}

function toggleSpaceExpanded(machineId: string | null, spaceId: string, isExpanded: boolean): void {
  localStorage.setItem(
    `${SPACE_EXPANDED_PREFIX}${getSpaceStorageKey(machineId, spaceId)}`,
    String(!isExpanded),
  );
  renderSessionList();
}

function getSpaceStorageKey(machineId: string | null, spaceId: string): string {
  return `${machineId ?? 'local'}:${spaceId}`;
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

function createChevron(expanded: boolean): HTMLSpanElement {
  const chevron = document.createElement('span');
  chevron.className = `spaces-tree-chevron${expanded ? ' expanded' : ''}`;
  chevron.textContent = '⌄';
  return chevron;
}

function createTextSpan(className: string, value: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = value;
  return span;
}

function queueSidebarTreeRender(): void {
  if (queuedRenderFrameId !== null) {
    return;
  }

  queuedRenderFrameId = window.requestAnimationFrame(() => {
    queuedRenderFrameId = null;
    renderSessionList();
    updateMobileTitle();
  });
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
