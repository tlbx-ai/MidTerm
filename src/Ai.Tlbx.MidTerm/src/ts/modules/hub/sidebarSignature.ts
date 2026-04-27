import { getHubSidebarSections, getLaunchableHubMachines } from './runtime';

export function getHubSidebarRenderSignature(): string {
  const machines = getLaunchableHubMachines()
    .map((machine) =>
      [
        'machine',
        machine.machine.id,
        machine.machine.name,
        machine.machine.enabled,
        machine.status,
        machine.requiresTrust,
        machine.fingerprintMismatch,
      ].join('\u001f'),
    )
    .sort();
  const sessions = getHubSidebarSections()
    .flatMap((section) =>
      section.sessions.map((session) =>
        [
          'session',
          section.machine.machine.id,
          session.id,
          session.name,
          session.terminalTitle,
          session.shellType,
          session.currentDirectory,
          session.workspacePath,
          session.spaceId,
          session.isAdHoc,
          session.bookmarkId,
          session.parentSessionId,
          session.order,
          session._order,
          session.agentControlled,
          session.lensOnly,
          session.surface,
          session.foregroundName,
          session.foregroundDisplayName,
          session.foregroundCommandLine,
        ].join('\u001f'),
      ),
    )
    .sort();
  return [...machines, ...sessions].join('\u001e');
}
