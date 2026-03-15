import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const translations: Record<string, string> = {
  'sidebar.humanControlled': 'Human controlled',
  'sidebar.agentControlled': 'Agent controlled',
};

const originalLocalStorage = globalThis.localStorage;

vi.mock('../i18n', () => ({
  t: (key: string) => translations[key] ?? key,
}));

describe('sessionList grouping', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    Object.assign(globalThis, {
      localStorage: originalLocalStorage,
    });
  });

  it('groups human sessions before agent sessions while preserving in-group order', async () => {
    const { groupSessionsByController } = await import('./sessionList');

    const groups = groupSessionsByController([
      { id: 'human-1', shellType: 'Pwsh', name: 'Human 1' } as any,
      { id: 'agent-1', shellType: 'Pwsh', name: 'Agent 1', agentControlled: true } as any,
      { id: 'human-2', shellType: 'Pwsh', name: 'Human 2' } as any,
      { id: 'agent-2', shellType: 'Pwsh', name: 'Agent 2', agentControlled: true } as any,
    ]);

    expect(groups.map((group) => group.key)).toEqual(['human', 'agent']);
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(['human-1', 'human-2']);
    expect(groups[1]?.sessions.map((session) => session.id)).toEqual(['agent-1', 'agent-2']);
  });

  it('omits empty groups', async () => {
    const { groupSessionsByController } = await import('./sessionList');

    const groups = groupSessionsByController([
      { id: 'agent-1', shellType: 'Pwsh', name: 'Agent 1', agentControlled: true } as any,
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('agent');
  });
});
