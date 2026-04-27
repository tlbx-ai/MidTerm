import { t } from '../i18n';
import { getForegroundInfo } from '../process';
import { createForegroundIndicator } from './sessionList';

export interface SpacesTreeSidebarSessionProcessEntry {
  id: string;
  session: {
    currentDirectory?: string | null;
    workspacePath?: string | null;
    shellType?: string | null;
  };
}

function getForegroundDisplay(entry: SpacesTreeSidebarSessionProcessEntry): {
  cwd: string | null;
  commandLine: string | null;
  processName: string;
  displayName: string | null;
} {
  const foreground = getForegroundInfo(entry.id);
  return {
    cwd: foreground.cwd || entry.session.currentDirectory || entry.session.workspacePath || null,
    commandLine: foreground.commandLine,
    processName: foreground.name?.trim() || entry.session.shellType || t('session.terminal'),
    displayName: foreground.displayName,
  };
}

function getForegroundSignature(entry: SpacesTreeSidebarSessionProcessEntry): string {
  const display = getForegroundDisplay(entry);
  return [
    display.cwd ?? '',
    display.commandLine ?? '',
    display.processName,
    display.displayName ?? '',
  ].join('\u001f');
}

export function syncSpacesTreeSidebarSessionProcessInfoElement(
  processInfo: HTMLElement,
  entry: SpacesTreeSidebarSessionProcessEntry,
): void {
  const signature = getForegroundSignature(entry);
  if (processInfo.dataset.foregroundSignature === signature) {
    return;
  }

  const display = getForegroundDisplay(entry);
  processInfo.dataset.foregroundSignature = signature;
  processInfo.replaceChildren(
    createForegroundIndicator(
      display.cwd,
      display.commandLine,
      display.processName,
      display.displayName,
    ),
  );
}

export function syncSpacesTreeSidebarSessionProcessInfo(
  host: HTMLElement,
  entries: SpacesTreeSidebarSessionProcessEntry[],
  sessionId: string,
): boolean {
  const entry = entries.find((candidate) => candidate.id === sessionId);
  if (!entry) {
    return true;
  }

  const items = Array.from(
    host.querySelectorAll<HTMLElement>('.session-item[data-session-id]'),
  ).filter((item) => item.dataset.sessionId === sessionId);
  if (items.length === 0) {
    return true;
  }

  for (const item of items) {
    const processInfo = item.querySelector<HTMLElement>('.session-process-info');
    if (!processInfo) {
      return false;
    }
    syncSpacesTreeSidebarSessionProcessInfoElement(processInfo, entry);
  }

  return true;
}
