import type {
  SessionInfoDto,
  SpaceCreateWorktreeRequest,
  SpaceDeleteWorktreeRequest,
  SpaceImportRequest,
  SpaceLaunchRequest,
  SpaceSummaryDto,
  SpaceUpdateRequest,
  SpaceUpdateWorkspaceRequest,
  LaunchEntry,
} from '../../api/types';

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error((await response.text()) || `Request failed (${response.status})`);
  }

  return (await response.json()) as T;
}

export async function fetchLocalSpaces(): Promise<SpaceSummaryDto[]> {
  return parseJson<SpaceSummaryDto[]>(await fetch('/api/spaces'));
}

export async function importLocalSpace(request: SpaceImportRequest): Promise<SpaceSummaryDto> {
  return parseJson<SpaceSummaryDto>(
    await fetch('/api/spaces/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );
}

export async function updateLocalSpace(
  spaceId: string,
  request: SpaceUpdateRequest,
): Promise<SpaceSummaryDto> {
  return parseJson<SpaceSummaryDto>(
    await fetch(`/api/spaces/${encodeURIComponent(spaceId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );
}

export async function deleteLocalSpace(spaceId: string): Promise<void> {
  const response = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error((await response.text()) || `Request failed (${response.status})`);
  }
}

export async function initLocalGit(spaceId: string): Promise<SpaceSummaryDto> {
  return parseJson<SpaceSummaryDto>(
    await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/git/init`, { method: 'POST' }),
  );
}

export async function createLocalWorktree(
  spaceId: string,
  request: SpaceCreateWorktreeRequest,
): Promise<SpaceSummaryDto> {
  return parseJson<SpaceSummaryDto>(
    await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/worktrees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );
}

export async function launchLocalSpaceWorkspace(
  spaceId: string,
  workspaceKey: string,
  request: SpaceLaunchRequest,
): Promise<SessionInfoDto> {
  return parseJson<SessionInfoDto>(
    await fetch(
      `/api/spaces/${encodeURIComponent(spaceId)}/workspaces/${encodeURIComponent(workspaceKey)}/launch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function fetchLocalRecents(): Promise<LaunchEntry[]> {
  return parseJson<LaunchEntry[]>(await fetch('/api/recents'));
}

export async function updateLocalWorkspace(
  spaceId: string,
  workspaceKey: string,
  request: SpaceUpdateWorkspaceRequest,
): Promise<SpaceSummaryDto> {
  return parseJson<SpaceSummaryDto>(
    await fetch(
      `/api/spaces/${encodeURIComponent(spaceId)}/workspaces/${encodeURIComponent(workspaceKey)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function deleteLocalWorktree(
  spaceId: string,
  workspaceKey: string,
  request: SpaceDeleteWorktreeRequest,
): Promise<SpaceSummaryDto> {
  const force = request.force === true ? 'true' : 'false';
  return parseJson<SpaceSummaryDto>(
    await fetch(
      `/api/spaces/${encodeURIComponent(spaceId)}/workspaces/${encodeURIComponent(workspaceKey)}?force=${force}`,
      { method: 'DELETE' },
    ),
  );
}

export async function fetchHubSpaces(machineId: string): Promise<SpaceSummaryDto[]> {
  return parseJson<SpaceSummaryDto[]>(
    await fetch(`/api/hub/machines/${encodeURIComponent(machineId)}/spaces`),
  );
}

export async function importHubSpace(
  machineId: string,
  request: SpaceImportRequest,
): Promise<SpaceSummaryDto> {
  return parseJson<SpaceSummaryDto>(
    await fetch(`/api/hub/machines/${encodeURIComponent(machineId)}/spaces/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );
}

export async function updateHubSpace(
  machineId: string,
  spaceId: string,
  request: SpaceUpdateRequest,
): Promise<SpaceSummaryDto> {
  return parseJson<SpaceSummaryDto>(
    await fetch(
      `/api/hub/machines/${encodeURIComponent(machineId)}/spaces/${encodeURIComponent(spaceId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function deleteHubSpace(machineId: string, spaceId: string): Promise<void> {
  const response = await fetch(
    `/api/hub/machines/${encodeURIComponent(machineId)}/spaces/${encodeURIComponent(spaceId)}`,
    {
      method: 'DELETE',
    },
  );
  if (!response.ok) {
    throw new Error((await response.text()) || `Request failed (${response.status})`);
  }
}

export async function initHubGit(machineId: string, spaceId: string): Promise<SpaceSummaryDto> {
  return parseJson<SpaceSummaryDto>(
    await fetch(
      `/api/hub/machines/${encodeURIComponent(machineId)}/spaces/${encodeURIComponent(spaceId)}/git/init`,
      {
        method: 'POST',
      },
    ),
  );
}

export async function createHubWorktree(
  machineId: string,
  spaceId: string,
  request: SpaceCreateWorktreeRequest,
): Promise<SpaceSummaryDto> {
  return parseJson<SpaceSummaryDto>(
    await fetch(
      `/api/hub/machines/${encodeURIComponent(machineId)}/spaces/${encodeURIComponent(spaceId)}/worktrees`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function launchHubSpaceWorkspace(
  machineId: string,
  spaceId: string,
  workspaceKey: string,
  request: SpaceLaunchRequest,
): Promise<SessionInfoDto> {
  return parseJson<SessionInfoDto>(
    await fetch(
      `/api/hub/machines/${encodeURIComponent(machineId)}/spaces/${encodeURIComponent(spaceId)}/workspaces/${encodeURIComponent(workspaceKey)}/launch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function fetchHubRecents(machineId: string): Promise<LaunchEntry[]> {
  return parseJson<LaunchEntry[]>(
    await fetch(`/api/hub/machines/${encodeURIComponent(machineId)}/recents`),
  );
}

export async function updateHubWorkspace(
  machineId: string,
  spaceId: string,
  workspaceKey: string,
  request: SpaceUpdateWorkspaceRequest,
): Promise<SpaceSummaryDto> {
  return parseJson<SpaceSummaryDto>(
    await fetch(
      `/api/hub/machines/${encodeURIComponent(machineId)}/spaces/${encodeURIComponent(spaceId)}/workspaces/${encodeURIComponent(workspaceKey)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function deleteHubWorktree(
  machineId: string,
  spaceId: string,
  workspaceKey: string,
  request: SpaceDeleteWorktreeRequest,
): Promise<SpaceSummaryDto> {
  const force = request.force === true ? 'true' : 'false';
  return parseJson<SpaceSummaryDto>(
    await fetch(
      `/api/hub/machines/${encodeURIComponent(machineId)}/spaces/${encodeURIComponent(spaceId)}/workspaces/${encodeURIComponent(workspaceKey)}?force=${force}`,
      { method: 'DELETE' },
    ),
  );
}
