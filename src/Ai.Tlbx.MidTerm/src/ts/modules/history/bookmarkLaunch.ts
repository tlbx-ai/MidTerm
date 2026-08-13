import type { CreateSessionRequest, LaunchEntry } from '../../api/types';

export function buildLocalBookmarkLaunchRequest(
  entry: LaunchEntry,
  cols: number,
  rows: number,
): CreateSessionRequest {
  return {
    cols,
    rows,
    shell: entry.shellType || null,
    workingDirectory: entry.workingDirectory || null,
    launchCommand: entry.commandLine || null,
  };
}
