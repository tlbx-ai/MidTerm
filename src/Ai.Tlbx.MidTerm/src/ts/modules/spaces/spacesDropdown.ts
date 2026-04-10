import type { LaunchEntry, ShellType, Session, SpaceSummaryDto } from '../../api/types';
import { t } from '../i18n';
import { getLaunchableHubMachines } from '../hub/runtime';
import { invalidateSidebarSpacesTree } from '../sidebar/spacesTreeSidebar';
import { showAlert } from '../../utils/dialog';
import { showImportSpaceDialog } from './spacesDialogs';
import { launchSpaceWorkspace } from './runtime';
import {
  fetchHubSpaces,
  fetchLocalSpaces,
  importHubSpace,
  importLocalSpace,
  updateHubSpace,
  updateLocalSpace,
} from './spacesApi';

interface SpaceTargetSection {
  id: string;
  label: string;
  machineId: string | null;
  spaces: SpaceSummaryDto[];
}

interface SpacesDropdownOptions {
  resolveLaunchDimensions: () => Promise<{ cols: number; rows: number }>;
  resolveShell: () => ShellType | null;
  onOpenLocalSession: (
    session: Session,
    surface: 'terminal' | 'codex' | 'claude',
  ) => void | Promise<void>;
  onOpenRemoteSession: (
    machineId: string,
    sessionId: string,
    surface: 'terminal' | 'codex' | 'claude',
  ) => void | Promise<void>;
  onSelectLocalSession: (sessionId: string) => void;
  onSelectRemoteSession: (machineId: string, sessionId: string) => void;
  onLaunchRecent: (machineId: string | null, entry: LaunchEntry) => void;
}

let dropdownEl: HTMLElement | null = null;
let isOpen = false;
let activeLoadToken = 0;
let sections: SpaceTargetSection[] = [];

export function initSpacesDropdown(_options: SpacesDropdownOptions): void {
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
  if (!dropdownEl) {
    return;
  }

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
    window.setTimeout(() => {
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
    results.push({
      id: 'local',
      label: t('sessionLauncher.localTargetTitle'),
      machineId: null,
      spaces: sortSpaces(await fetchLocalSpaces()),
    });
  } catch {
    results.push({
      id: 'local',
      label: t('sessionLauncher.localTargetTitle'),
      machineId: null,
      spaces: [],
    });
  }

  const remoteSections = await Promise.all(
    machines.map(async (machine) => {
      try {
        return {
          id: machine.machine.id,
          label: machine.machine.name,
          machineId: machine.machine.id,
          spaces: sortSpaces(await fetchHubSpaces(machine.machine.id)),
        } satisfies SpaceTargetSection;
      } catch {
        return {
          id: machine.machine.id,
          label: machine.machine.name,
          machineId: machine.machine.id,
          spaces: [],
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
    <div class="history-dropdown-header spaces-dropdown-header">
      <span>${escapeHtml(t('spaces.title'))}</span>
      <button type="button" class="spaces-add-btn" data-action="add-space">
        ${escapeHtml(t('spaces.addNew'))}
      </button>
    </div>
    <div class="history-dropdown-content"></div>
    <div class="history-dropdown-empty hidden">${escapeHtml(t('spaces.empty'))}</div>
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

    const machineId = normalizeMachineId(actionEl.dataset.machineId);
    const spaceId = actionEl.dataset.spaceId ?? null;
    void handleAction({ action, machineId, spaceId });
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
}): Promise<void> {
  switch (args.action) {
    case 'open-space':
      if (args.spaceId) {
        await openSpace(args.machineId, args.spaceId);
      }
      return;
    case 'add-space':
      await promptAndImportSpace(args.machineId);
      return;
    case 'toggle-pin':
      if (args.spaceId) {
        await toggleSpacePinned(args.machineId, args.spaceId);
      }
      return;
  }
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

async function toggleSpacePinned(machineId: string | null, spaceId: string): Promise<void> {
  const space = findSpace(machineId, spaceId);
  if (!space) {
    return;
  }

  try {
    if (machineId) {
      await updateHubSpace(machineId, space.id, { isPinned: !space.isPinned });
    } else {
      await updateLocalSpace(space.id, { isPinned: !space.isPinned });
    }

    await refreshSpacesDropdown();
    invalidateSidebarSpacesTree();
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: space.isPinned ? t('spaces.unpinSpace') : t('spaces.pinSpace'),
    });
  }
}

async function openSpace(machineId: string | null, spaceId: string): Promise<void> {
  const space = findSpace(machineId, spaceId);
  if (!space) {
    return;
  }

  const workspace = resolvePrimaryWorkspace(space);
  if (!workspace) {
    return;
  }

  const launched = await launchSpaceWorkspace(machineId, space.id, workspace, 'terminal');
  if (launched) {
    closeSpacesDropdown();
    invalidateSidebarSpacesTree();
  }
}

function positionDropdown(): void {
  if (!dropdownEl) {
    return;
  }

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

  content.innerHTML = '';

  const totalSpaces = sections.reduce((count, section) => count + section.spaces.length, 0);
  empty.classList.toggle('hidden', totalSpaces > 0);

  for (const section of sections) {
    const sectionEl = document.createElement('section');
    sectionEl.className = 'spaces-section';

    sectionEl.innerHTML = `
      <div class="history-section-header spaces-section-header">
        <span>${escapeHtml(section.label)}</span>
      </div>
    `;

    const list = document.createElement('div');
    list.className = 'spaces-section-list';

    if (section.spaces.length === 0) {
      const emptyRow = document.createElement('div');
      emptyRow.className = 'spaces-empty-row';
      emptyRow.textContent = t('spaces.empty');
      list.appendChild(emptyRow);
    } else {
      for (const space of section.spaces) {
        list.appendChild(createSpaceRow(space, section.machineId));
      }
    }

    sectionEl.appendChild(list);
    content.appendChild(sectionEl);
  }
}

function createSpaceRow(space: SpaceSummaryDto, machineId: string | null): HTMLElement {
  const row = document.createElement('div');
  row.className = `history-item spaces-space-row${space.isPinned ? ' pinned' : ''}`;
  row.title = buildSpaceRowTitle(space);

  const pinButton = document.createElement('button');
  pinButton.type = 'button';
  pinButton.className = `history-item-star${space.isPinned ? ' starred' : ''}`;
  pinButton.dataset.action = 'toggle-pin';
  pinButton.dataset.spaceId = space.id;
  pinButton.dataset.machineId = machineId ?? '';
  pinButton.title = space.isPinned ? t('spaces.unpinSpace') : t('spaces.pinSpace');
  pinButton.setAttribute('aria-label', pinButton.title);
  pinButton.setAttribute('aria-pressed', space.isPinned ? 'true' : 'false');
  pinButton.textContent = space.isPinned ? '★' : '☆';
  row.appendChild(pinButton);

  const launchButton = document.createElement('button');
  launchButton.type = 'button';
  launchButton.className = 'spaces-space-launch';
  launchButton.dataset.action = 'open-space';
  launchButton.dataset.spaceId = space.id;
  launchButton.dataset.machineId = machineId ?? '';
  launchButton.title = buildSpaceRowTitle(space);

  const info = document.createElement('div');
  info.className = 'history-item-info spaces-space-info';

  const path = document.createElement('span');
  path.className = 'history-item-text spaces-space-path';
  path.textContent = space.rootPath;
  info.appendChild(path);

  launchButton.appendChild(info);
  row.appendChild(launchButton);

  return row;
}

function sortSpaces(spaces: SpaceSummaryDto[]): SpaceSummaryDto[] {
  return [...spaces].sort((left, right) => {
    if (left.isPinned !== right.isPinned) {
      return left.isPinned ? -1 : 1;
    }

    return left.rootPath.localeCompare(right.rootPath);
  });
}

function findSpace(machineId: string | null, spaceId: string): SpaceSummaryDto | undefined {
  return sections
    .find((section) => section.machineId === machineId)
    ?.spaces.find((space) => space.id === spaceId);
}

function normalizeMachineId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function buildSpaceRowTitle(space: SpaceSummaryDto): string {
  if (space.label.trim() && space.label.trim() !== space.rootPath.trim()) {
    return `${space.label}\n${space.rootPath}`;
  }

  return space.rootPath;
}

function resolvePrimaryWorkspace(space: SpaceSummaryDto) {
  return (
    space.workspaces.find((workspace) => workspace.path === space.rootPath) ??
    space.workspaces.find((workspace) => workspace.isMain) ??
    space.workspaces[0]
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
