import type { Session, SpaceSummaryDto, SpaceWorkspaceDto } from '../../api/types';

export function isAdHocSession(session: Pick<Session, 'isAdHoc' | 'spaceId'>): boolean {
  if (typeof session.isAdHoc === 'boolean') {
    return session.isAdHoc;
  }

  return !session.spaceId?.trim();
}

export function getRootWorkspace(
  space: Pick<SpaceSummaryDto, 'rootPath' | 'workspaces'>,
): SpaceWorkspaceDto | null {
  return (
    space.workspaces.find((workspace) => workspace.isMain) ??
    space.workspaces.find(
      (workspace) =>
        normalizeOptionalPath(workspace.path) === normalizeOptionalPath(space.rootPath),
    ) ??
    space.workspaces[0] ??
    null
  );
}

export function getChildWorkspaces(
  space: Pick<SpaceSummaryDto, 'rootPath' | 'workspaces'>,
): SpaceWorkspaceDto[] {
  const rootWorkspace = getRootWorkspace(space);
  if (!rootWorkspace) {
    return [];
  }

  const rootPath = normalizeOptionalPath(rootWorkspace.path);
  return space.workspaces.filter((workspace) => normalizeOptionalPath(workspace.path) !== rootPath);
}

function normalizeOptionalPath(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
