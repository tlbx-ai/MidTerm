import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const translations: Record<string, string> = {
  'sidebar.humanControlled': 'Human controlled',
  'sidebar.agentControlled': 'Agent controlled',
  'sidebar.noMatchingTerminals': 'No terminals match the current filter',
};

const originalLocalStorage = globalThis.localStorage;

vi.mock('../i18n', () => ({
  t: (key: string) => translations[key] ?? key,
}));

describe('sessionList grouping', () => {
  beforeEach(() => {
    vi.resetModules();
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
    expect(groups.every((group) => group.showHeader)).toBe(true);
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
    expect(groups[0]?.showHeader).toBe(true);
  });

  it('sorts agent sessions with attention before quiet workers', async () => {
    const { groupSessionsByController } = await import('./sessionList');

    const groups = groupSessionsByController([
      {
        id: 'agent-busy',
        shellType: 'Pwsh',
        name: 'Busy worker',
        agentControlled: true,
        order: 2,
        supervisor: { state: 'busy-turn', attentionScore: 10, needsAttention: false },
      } as any,
      {
        id: 'agent-blocked',
        shellType: 'Pwsh',
        name: 'Blocked worker',
        agentControlled: true,
        order: 1,
        supervisor: { state: 'blocked', attentionScore: 95, needsAttention: true },
      } as any,
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.attentionCount).toBe(1);
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(['agent-blocked', 'agent-busy']);
  });

  it('hides group headers when only human sessions are visible', async () => {
    const { groupSessionsByController } = await import('./sessionList');

    const groups = groupSessionsByController([
      { id: 'human-1', shellType: 'Pwsh', name: 'Human 1' } as any,
      { id: 'human-2', shellType: 'Pwsh', name: 'Human 2' } as any,
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('human');
    expect(groups[0]?.showHeader).toBe(false);
  });

  it('filters sessions by title, shell, and current directory tokens', async () => {
    const { filterSessionsByQuery } = await import('./sessionList');

    const filtered = filterSessionsByQuery(
      [
        {
          id: 'human-1',
          shellType: 'Pwsh',
          name: 'Inbox',
          terminalTitle: 'Mail triage',
          currentDirectory: 'Q:\\repos\\Jpa',
        } as any,
        {
          id: 'agent-1',
          shellType: 'Pwsh',
          name: 'Worker',
          terminalTitle: 'MidTerm sidebar',
          currentDirectory: 'Q:\\repos\\MidtermJpa',
          agentControlled: true,
        } as any,
      ],
      'midterm q:\\repos\\midtermjpa',
    );

    expect(filtered.map((session) => session.id)).toEqual(['agent-1']);
  });

  it('removes empty controller groups after filtering', async () => {
    const { filterSessionsByQuery, groupSessionsByController } = await import('./sessionList');

    const groups = groupSessionsByController(
      filterSessionsByQuery(
        [
          { id: 'human-1', shellType: 'Pwsh', name: 'Inbox' } as any,
          { id: 'agent-1', shellType: 'Pwsh', name: 'Worker', agentControlled: true } as any,
        ],
        'worker',
      ),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('agent');
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(['agent-1']);
  });

  it('only shows the AI control action for AI-controlled sessions', async () => {
    const { shouldShowAgentControlAction } = await import('./sessionList');

    expect(shouldShowAgentControlAction('agent')).toBe(true);
    expect(shouldShowAgentControlAction('human')).toBe(false);
  });

  it('keeps stored queries inactive until the sidebar filter setting is enabled', async () => {
    const localStorageMock = {
      getItem: vi.fn(() => 'worker'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal('localStorage', localStorageMock);
    vi.stubGlobal('document', { addEventListener: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn() });

    const stores = await import('../../stores');
    const state = await import('../../state');
    const { applySessionFilterSettingChange, initializeSessionList, isSessionFilterActive } =
      await import('./sessionList');

    const filterBar = {
      hidden: false,
      toggleAttribute(name: string, force?: boolean) {
        if (name === 'hidden') {
          this.hidden = force !== false;
        }
      },
    };
    const filterInput = {
      value: '',
      focus: vi.fn(),
      blur: vi.fn(),
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
    };
    const clearButton = {
      hidden: false,
      toggleAttribute(name: string, force?: boolean) {
        if (name === 'hidden') {
          this.hidden = force !== false;
        }
      },
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
    };
    state.dom.sessionFilterBar = filterBar as any;
    state.dom.sessionFilterInput = filterInput as any;
    state.dom.sessionFilterClear = clearButton as any;

    initializeSessionList();
    expect(isSessionFilterActive()).toBe(false);
    expect(filterBar.hidden).toBe(true);
    expect(clearButton.hidden).toBe(true);
    expect(filterInput.value).toBe('');

    stores.$currentSettings.set({ showSidebarSessionFilter: true } as any);
    applySessionFilterSettingChange();
    expect(isSessionFilterActive()).toBe(true);
    expect(filterBar.hidden).toBe(false);
    expect(clearButton.hidden).toBe(false);
    expect(filterInput.value).toBe('worker');

    stores.$currentSettings.set({ showSidebarSessionFilter: false } as any);
    applySessionFilterSettingChange();
    expect(isSessionFilterActive()).toBe(false);
    expect(filterBar.hidden).toBe(true);
    expect(clearButton.hidden).toBe(true);
    expect(filterInput.value).toBe('');
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('midterm.sidebar.sessionFilter');
  });

  it('keeps only the requested sidebar item active after rerender normalization', async () => {
    const { syncSessionItemActiveStates } = await import('./sessionList');

    const createItem = (sessionId: string, active: boolean) => {
      const classes = new Set(active ? ['session-item', 'active'] : ['session-item']);
      const attributes = new Map<string, string>([['aria-current', active ? 'true' : 'false']]);

      return {
        dataset: { sessionId },
        classList: {
          add: (name: string) => classes.add(name),
          remove: (name: string) => classes.delete(name),
          contains: (name: string) => classes.has(name),
        },
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        getAttribute: (name: string) => attributes.get(name) ?? null,
      };
    };

    const items = [
      createItem('session-a', true),
      createItem('session-b', true),
      createItem('session-c', false),
    ];

    const root = {
      querySelectorAll: (selector: string) =>
        selector === '.session-item.active'
          ? items.filter((item) => item.classList.contains('active'))
          : [],
      querySelector: (selector: string) => {
        const match = selector.match(/data-session-id="([^"]+)"/);
        if (!match) {
          return null;
        }

        return items.find((item) => item.dataset.sessionId === match[1]) ?? null;
      },
    };

    const activeItem = syncSessionItemActiveStates(root as any, 'session-c');

    expect(activeItem?.dataset.sessionId).toBe('session-c');
    expect(items.filter((item) => item.classList.contains('active')).map((item) => item.dataset.sessionId)).toEqual([
      'session-c',
    ]);
    expect(items[0]?.getAttribute('aria-current')).toBe('false');
    expect(items[2]?.getAttribute('aria-current')).toBe('true');
  });
});
