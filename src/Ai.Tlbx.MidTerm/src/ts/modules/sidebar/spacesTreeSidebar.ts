import type { LaunchEntry, Session, SpaceSummaryDto, SpaceWorkspaceDto } from '../../api/types';
import { icon } from '../../constants';
import { t } from '../i18n';
import { dom } from '../../state';
import { $activeSessionId, $currentSettings, $sessionList, $settingsOpen } from '../../stores';
import { getLaunchableHubMachines, getHubSidebarSections } from '../hub/runtime';
import { showAlert, showConfirm, showTextPrompt } from '../../utils/dialog';
import {
  createHubWorktree,
  createLocalWorktree,
  deleteHubSpace,
  deleteLocalSpace,
  fetchHubSpaces,
  fetchLocalSpaces,
  importHubSpace,
  importLocalSpace,
  initHubGit,
  initLocalGit,
  updateHubSpace,
  updateLocalSpace,
} from '../spaces/spacesApi';
import { showCreateWorktreeDialog, showImportSpaceDialog } from '../spaces/spacesDialogs';
import { launchSpaceWorkspace, type SpaceSurface } from '../spaces/runtime';
import { addProcessStateListener, getForegroundInfo } from '../process';
import {
  getSessionDisplayInfo,
  getSessionDisplayName as getLegacySessionDisplayName,
} from './sessionList';
import { createSessionFilterController } from './sessionFilterController';

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
let queuedRenderFrameId: number | null = null;

const SPACE_MANAGE_PREFIX = 'midterm.sidebar.spaceManage.';
const SESSION_FILTER_STORAGE_KEY = 'midterm.sidebar.sessionFilter';
const TREE_TTL_MS = 15_000;

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
    // Ignore localStorage failures and keep the filter in memory.
  }
}

function isSidebarSessionFilterEnabled(): boolean {
  return $currentSettings.get()?.showSidebarSessionFilter === true;
}

const sessionFilterController = createSessionFilterController({
  getElements: () => ({
    filterBar: dom.sessionFilterBar,
    filterInput: dom.sessionFilterInput,
    filterClear: dom.sessionFilterClear,
  }),
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
  addProcessStateListener(queueSidebarTreeRender);
  sessionFilterController.initialize();
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
  if (hasSessions || hasSpaces) {
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
  const [localSpaces, remoteSections] = await Promise.all([
    fetchLocalSpaces().catch(() => []),
    Promise.all(
      machines.map(async (machine) => ({
        id: machine.machine.id,
        label: machine.machine.name,
        machineId: machine.machine.id,
        spaces: await fetchHubSpaces(machine.machine.id).catch(() => []),
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
  const filteredSpaces = section.spaces
    .map((space) => filterSpace(section.machineId, space))
    .filter((space): space is SpaceSummaryDto => space !== null);
  return {
    ...section,
    spaces: filteredSpaces,
  };
}

function filterSpace(machineId: string | null, space: SpaceSummaryDto): SpaceSummaryDto | null {
  if (!space.isPinned) {
    return null;
  }

  const searchValue = getSearchValue();
  const textMatch = matchesSpaceSearch(space);
  if (!searchValue || textMatch) {
    return space;
  }

  const matchingWorkspaces = space.workspaces.filter((workspace) =>
    matchesWorkspaceSearch(workspace),
  );
  const hasSession = hasMatchingSpaceSession(machineId, space);
  return matchingWorkspaces.length > 0 || hasSession
    ? {
        ...space,
        workspaces: matchingWorkspaces.length > 0 ? matchingWorkspaces : space.workspaces,
      }
    : null;
}

function hasMatchingSpaceSession(machineId: string | null, space: SpaceSummaryDto): boolean {
  return getAllSidebarSessions().some(
    (entry) => sessionBelongsToSpace(entry, machineId, space) && matchesSidebarSessionSearch(entry),
  );
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
      section.spaces.some((space) => {
        const visibleSpace = filterSpace(section.machineId, space);
        return visibleSpace ? sessionBelongsToSpace(entry, section.machineId, visibleSpace) : false;
      }),
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

  return wrapper;
}

function createSpaceNode(machineId: string | null, space: SpaceSummaryDto): HTMLElement {
  const normalizedKey = `${machineId ?? 'local'}:${space.id}`;
  const node = document.createElement('article');
  node.className = 'spaces-tree-space';
  if (isSpaceManageOpen(normalizedKey)) {
    node.classList.add('manage-open');
  }

  const sessions = getVisibleSpaceSessions(machineId, space);
  const showWorkspaceList =
    isSpaceManageOpen(normalizedKey) || shouldShowWorkspacesForSearch(space);

  const headerRow = document.createElement('div');
  headerRow.className = 'spaces-tree-space-header-row';

  const header = document.createElement('div');
  header.className = 'spaces-tree-space-header';

  const identity = document.createElement('div');
  identity.className = 'spaces-tree-space-identity';

  const titleRow = document.createElement('div');
  titleRow.className = 'spaces-tree-space-title-row';
  titleRow.appendChild(createTextSpan('spaces-tree-space-title', space.label));
  if (sessions.length > 0) {
    titleRow.appendChild(createTextSpan('spaces-tree-space-count', String(sessions.length)));
  }
  identity.appendChild(titleRow);

  const path = document.createElement('div');
  path.className = 'spaces-tree-space-path';
  path.textContent = space.rootPath;
  path.title = space.rootPath;
  identity.appendChild(path);

  header.appendChild(identity);
  header.appendChild(createSpaceHeaderActions(machineId, space, normalizedKey, node));
  node.appendChild(headerRow);
  headerRow.appendChild(header);

  if (sessions.length === 0 && !showWorkspaceList) {
    return node;
  }

  const body = document.createElement('div');
  body.className = 'spaces-tree-space-body';
  if (sessions.length > 0) {
    const sessionList = document.createElement('div');
    sessionList.className = 'spaces-tree-space-session-list';
    for (const entry of sessions) {
      sessionList.appendChild(createSidebarSessionNode(entry));
    }
    body.appendChild(sessionList);
  }

  if (showWorkspaceList) {
    const workspaceList = document.createElement('div');
    workspaceList.className = 'spaces-tree-workspace-list';
    for (const workspace of getVisibleSpaceWorkspaces(space)) {
      workspaceList.appendChild(createWorkspaceNode(machineId, space, workspace));
    }
    body.appendChild(workspaceList);
  }

  node.appendChild(body);
  return node;
}

function createSpaceHeaderActions(
  machineId: string | null,
  space: SpaceSummaryDto,
  normalizedKey: string,
  node: HTMLElement,
): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'spaces-tree-space-actions';

  if (space.kind === 'git') {
    actions.appendChild(
      createActionButton(
        t('spaces.newWorktree'),
        () => {
          void promptAndCreateWorktree(machineId, space.id);
        },
        'secondary',
      ),
    );
    actions.appendChild(
      createActionButton(
        t('spaces.worktrees'),
        () => {
          toggleSpaceManage(node, normalizedKey);
        },
        'secondary',
      ),
    );
  } else {
    actions.appendChild(
      createActionButton(
        t('spaces.initGit'),
        () => {
          void initGit(machineId, space.id);
        },
        'secondary',
      ),
    );
  }

  actions.appendChild(
    createActionButton(
      t('sidebar.rename'),
      () => {
        void promptAndRenameSpace(machineId, space);
      },
      'secondary',
    ),
  );
  actions.appendChild(
    createActionButton(
      t('spaces.deleteSpace'),
      () => {
        void promptAndDeleteSpace(machineId, space);
      },
      'danger',
    ),
  );

  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = `spaces-tree-pin${space.isPinned ? ' pinned' : ''}`;
  pin.title = space.isPinned ? t('spaces.unpinSpace') : t('spaces.pinSpace');
  pin.textContent = space.isPinned ? '★' : '☆';
  pin.addEventListener('click', (event) => {
    event.stopPropagation();
    void toggleSpacePinned(machineId, space);
  });
  actions.appendChild(pin);

  return actions;
}

function createWorkspaceNode(
  machineId: string | null,
  space: SpaceSummaryDto,
  workspace: SpaceWorkspaceDto,
): HTMLElement {
  const node = document.createElement('div');
  node.className = 'spaces-tree-workspace';

  const sessions = getWorkspaceSessions(machineId, space, workspace);
  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'spaces-tree-workspace-open';
  openButton.addEventListener('click', () => {
    const activeSession =
      sessions.find((session) => session.id === $activeSessionId.get()) ?? sessions[0];
    if (activeSession) {
      callbacks?.onSelect(activeSession.id);
      callbacks?.onCloseSidebar();
      return;
    }

    void openWorkspace(machineId, space.id, workspace, 'terminal');
  });

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
  openButton.appendChild(line);

  const path = document.createElement('div');
  path.className = 'spaces-tree-workspace-path';
  path.textContent = workspace.path;
  path.title = workspace.path;
  openButton.appendChild(path);
  node.appendChild(openButton);

  if (sessions.length > 0) {
    const badge = document.createElement('div');
    badge.className = 'spaces-tree-workspace-session-count';
    badge.textContent = `${sessions.length}`;
    node.appendChild(badge);
  }

  return node;
}

function createSidebarSessionNode(entry: SidebarSessionRef): HTMLElement {
  const item = document.createElement('div');
  item.className = `session-item two-line spaces-tree-session-item${entry.id === $activeSessionId.get() ? ' active' : ''}`;
  item.addEventListener('click', () => {
    callbacks?.onSelect(entry.id);
    callbacks?.onCloseSidebar();
  });

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
  header.innerHTML = `
    <span class="spaces-tree-target-label">${escapeHtml(t('spaces.adHocSessions'))}</span>
    <span class="spaces-tree-target-count">${sessions.length}</span>
  `;
  section.appendChild(header);

  const list = document.createElement('div');
  list.className = 'spaces-tree-adhoc-list';
  for (const entry of sessions) {
    const location = entry.session.workspacePath || entry.session.currentDirectory;
    const item = document.createElement('div');
    item.className = 'spaces-tree-adhoc-item';
    item.appendChild(createSidebarSessionNode(entry));
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
    .filter((entry) => matchesSidebarSessionSearch(entry))
    .sort((left, right) =>
      getSessionDisplayName(left.session).localeCompare(getSessionDisplayName(right.session)),
    );
}

function getVisibleSpaceWorkspaces(space: SpaceSummaryDto): SpaceWorkspaceDto[] {
  if (!getSearchValue()) {
    return space.workspaces;
  }

  return space.workspaces.filter((workspace) => matchesWorkspaceSearch(workspace));
}

function shouldShowWorkspacesForSearch(space: SpaceSummaryDto): boolean {
  return getSearchValue().length > 0 && getVisibleSpaceWorkspaces(space).length > 0;
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

function matchesAdHocSearch(entry: SidebarSessionRef): boolean {
  return matchesSidebarSessionSearch(entry);
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

async function promptAndRenameSpace(
  machineId: string | null,
  space: SpaceSummaryDto,
): Promise<void> {
  const nextName = await showTextPrompt({
    title: t('spaces.renameSpaceTitle'),
    initialValue: space.label,
    validate: (value) => (value.trim().length === 0 ? t('spaces.spaceNameRequired') : null),
  });
  if (nextName === null) {
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
  const hasActiveSessions = getSpaceSessions(machineId, space).length > 0;
  const confirmed = await showConfirm(
    (hasActiveSessions
      ? t('spaces.deleteSpaceActiveSessions')
      : t('spaces.deleteSpaceConfirm')
    ).replace('{name}', space.label),
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

function isSpaceManageOpen(key: string): boolean {
  return localStorage.getItem(`${SPACE_MANAGE_PREFIX}${key}`) === 'true';
}

function toggleSpaceManage(node: HTMLElement, key: string): void {
  const next = !node.classList.contains('manage-open');
  node.classList.toggle('manage-open', next);
  localStorage.setItem(`${SPACE_MANAGE_PREFIX}${key}`, String(next));
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
