import { describe, expect, it } from 'vitest';
import { getChildWorkspaces, getRootWorkspace, isAdHocSession } from './spacesTreeSidebarLogic';

describe('spacesTreeSidebar session classification', () => {
  it('keeps generic new-session entries ad hoc even when they have a workspace path', () => {
    expect(
      isAdHocSession({
        isAdHoc: true,
        spaceId: null,
      } as any),
    ).toBe(true);
  });

  it('falls back to missing space ids when older payloads omit isAdHoc', () => {
    expect(
      isAdHocSession({
        spaceId: null,
      } as any),
    ).toBe(true);

    expect(
      isAdHocSession({
        spaceId: 'space-1',
      } as any),
    ).toBe(false);
  });
});

describe('spacesTreeSidebar workspace layout', () => {
  it('treats the main workspace as the root workspace', () => {
    const root = getRootWorkspace({
      rootPath: 'Q:/repos/MidTerm',
      workspaces: [
        {
          key: 'root',
          displayName: 'Main',
          path: 'Q:/repos/MidTerm',
          kind: 'worktree',
          isMain: true,
          isDetached: false,
          locked: false,
          prunable: false,
          changeCount: 0,
          hasChanges: false,
          hasActiveAiSession: false,
          activeSessions: [],
        },
        {
          key: 'wt1',
          displayName: 'auth-fix',
          path: 'Q:/wt/MidTerm/auth-fix',
          kind: 'worktree',
          isMain: false,
          isDetached: false,
          locked: false,
          prunable: false,
          changeCount: 0,
          hasChanges: false,
          hasActiveAiSession: false,
          activeSessions: [],
        },
      ],
    } as any);

    expect(root?.path).toBe('Q:/repos/MidTerm');
  });

  it('falls back to the space root path when older payloads omit isMain', () => {
    const root = getRootWorkspace({
      rootPath: 'Q:/repos/MidTerm',
      workspaces: [
        {
          key: 'wt1',
          displayName: 'auth-fix',
          path: 'Q:/wt/MidTerm/auth-fix',
          kind: 'worktree',
          isMain: false,
          isDetached: false,
          locked: false,
          prunable: false,
          changeCount: 0,
          hasChanges: false,
          hasActiveAiSession: false,
          activeSessions: [],
        },
        {
          key: 'root',
          displayName: 'whatever',
          path: 'Q:/repos/MidTerm',
          kind: 'worktree',
          isMain: false,
          isDetached: false,
          locked: false,
          prunable: false,
          changeCount: 0,
          hasChanges: false,
          hasActiveAiSession: false,
          activeSessions: [],
        },
      ],
    } as any);

    expect(root?.path).toBe('Q:/repos/MidTerm');
  });

  it('renders only non-root workspaces as child worktrees', () => {
    const childWorkspaces = getChildWorkspaces({
      rootPath: 'Q:/repos/MidTerm',
      workspaces: [
        {
          key: 'root',
          displayName: 'Main',
          path: 'Q:/repos/MidTerm',
          kind: 'worktree',
          isMain: true,
          isDetached: false,
          locked: false,
          prunable: false,
          changeCount: 0,
          hasChanges: false,
          hasActiveAiSession: false,
          activeSessions: [],
        },
        {
          key: 'wt1',
          displayName: 'auth-fix',
          path: 'Q:/wt/MidTerm/auth-fix',
          kind: 'worktree',
          isMain: false,
          isDetached: false,
          locked: false,
          prunable: false,
          changeCount: 0,
          hasChanges: false,
          hasActiveAiSession: false,
          activeSessions: [],
        },
      ],
    } as any);

    expect(childWorkspaces).toHaveLength(1);
    expect(childWorkspaces[0]?.path).toBe('Q:/wt/MidTerm/auth-fix');
  });
});
