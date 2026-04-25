import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutNode } from '../../types';

const mocks = vi.hoisted(() => ({
  createTerminalForSession: vi.fn(),
  setSuppressLayoutAutoFit: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../terminal/manager', () => ({
  createTerminalForSession: mocks.createTerminalForSession,
}));

vi.mock('../../state', () => ({
  sessionTerminals: new Map<string, unknown>(),
  setSuppressLayoutAutoFit: mocks.setSuppressLayoutAutoFit,
}));

async function loadHarness() {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('fetch', mocks.fetch);

  const localStorageData = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => localStorageData.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      localStorageData.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      localStorageData.delete(key);
    }),
  });

  mocks.createTerminalForSession.mockReset();
  mocks.setSuppressLayoutAutoFit.mockReset();
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ revision: 1, root: null, focusedSessionId: null }),
  });

  const stores = await import('../../stores');
  stores.$layout.set({ root: null });
  stores.$focusedSessionId.set(null);
  stores.$activeSessionId.set(null);
  stores.$sessions.set({
    'session-a': { id: 'session-a', cols: 120, rows: 30 } as any,
    'session-b': { id: 'session-b', cols: 120, rows: 30 } as any,
  });

  const layoutStore = await import('./layoutStore');
  return { stores, layoutStore };
}

function buildHorizontalLayout(): LayoutNode {
  return {
    type: 'split',
    direction: 'horizontal',
    children: [
      { type: 'leaf', sessionId: 'session-a' },
      { type: 'leaf', sessionId: 'session-b' },
    ],
  };
}

function buildVerticalLayout(): LayoutNode {
  return {
    type: 'split',
    direction: 'vertical',
    children: [
      { type: 'leaf', sessionId: 'session-a' },
      { type: 'leaf', sessionId: 'session-b' },
    ],
  };
}

describe('layoutStore server sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('ignores stale server snapshots while a local layout change is pending', async () => {
    const { stores, layoutStore } = await loadHarness();
    layoutStore.applyServerLayoutState({ revision: 1, root: null, focusedSessionId: null });
    layoutStore.initLayoutPersistence();
    layoutStore.markLayoutPersistenceReady();

    const optimisticLayout = buildHorizontalLayout();
    stores.$layout.set({ root: optimisticLayout });
    stores.$focusedSessionId.set('session-b');

    layoutStore.applyServerLayoutState({ revision: 1, root: null, focusedSessionId: null });

    expect(stores.$layout.get().root).toEqual(optimisticLayout);
    expect(stores.$focusedSessionId.get()).toBe('session-b');
  });

  it('does not let an older server ack overwrite a newer pending local layout edit', async () => {
    const { stores, layoutStore } = await loadHarness();
    layoutStore.applyServerLayoutState({ revision: 1, root: null, focusedSessionId: null });
    layoutStore.initLayoutPersistence();
    layoutStore.markLayoutPersistenceReady();

    const olderLayout = buildHorizontalLayout();
    const newerLayout = buildVerticalLayout();
    stores.$layout.set({ root: olderLayout });
    stores.$focusedSessionId.set('session-b');
    stores.$layout.set({ root: newerLayout });

    layoutStore.applyServerLayoutState({
      revision: 2,
      root: olderLayout,
      focusedSessionId: 'session-b',
    });

    expect(stores.$layout.get().root).toEqual(newerLayout);
    expect(stores.$focusedSessionId.get()).toBe('session-b');
  });

  it('docks onto Lens sessions without creating a terminal surface for the Lens target', async () => {
    const { stores, layoutStore } = await loadHarness();
    stores.$sessions.set({
      'terminal-session': {
        id: 'terminal-session',
        cols: 120,
        rows: 30,
        lensOnly: false,
      } as any,
      'lens-session': {
        id: 'lens-session',
        cols: 0,
        rows: 0,
        lensOnly: true,
      } as any,
    });

    layoutStore.dockSession('lens-session', 'terminal-session', 'left');

    expect(mocks.createTerminalForSession).toHaveBeenCalledTimes(1);
    expect(mocks.createTerminalForSession).toHaveBeenCalledWith(
      'terminal-session',
      expect.objectContaining({ id: 'terminal-session' }),
    );
    expect(stores.$layout.get().root).toEqual({
      type: 'split',
      direction: 'horizontal',
      children: [
        { type: 'leaf', sessionId: 'terminal-session' },
        { type: 'leaf', sessionId: 'lens-session' },
      ],
    });
  });
});
