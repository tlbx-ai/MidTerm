import { beforeEach, describe, expect, it, vi } from 'vitest';

const focusSpy = vi.fn();
const refreshTerminalPresentationSpy = vi.fn();
const applyTerminalScalingSyncSpy = vi.fn();
const fitSessionToScreenSpy = vi.fn();
let isMainBrowser = false;
let sessionListMock: any[] = [];
const terminalContainer = {
  children: [] as any[],
  appendChild(child: any) {
    this.children.push(child);
    return child;
  },
} as HTMLDivElement;

const visibleTabs = new Map<string, Set<string>>();

function createMockElement(): HTMLDivElement {
  return {
    dataset: {} as Record<string, string>,
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
    },
    children: [] as any[],
    innerHTML: '',
    appendChild(child: any) {
      this.children.push(child);
      return child;
    },
  } as unknown as HTMLDivElement;
}

vi.mock('../logging', () => ({
  createLogger: () => ({
    info: vi.fn(),
    verbose: vi.fn(),
  }),
}));

vi.mock('./tabBar', () => ({
  createTabBar: (sessionId: string) => {
    visibleTabs.set(sessionId, new Set(['terminal', 'agent', 'files']));
    return {
      dataset: { sessionId },
      offsetHeight: 42,
    } as HTMLDivElement;
  },
  isTabVisible: (bar: HTMLDivElement, tab: string) =>
    visibleTabs.get(bar.dataset.sessionId ?? '')?.has(tab) ?? false,
  setActiveTab: vi.fn(),
  setActionActive: vi.fn(),
  setActionVisible: vi.fn(),
  setTabLabel: vi.fn(),
  setTabVisible: (bar: HTMLDivElement, tab: string, visible: boolean) => {
    const tabs = visibleTabs.get(bar.dataset.sessionId ?? '');
    if (!tabs) return;
    if (visible) {
      tabs.add(tab);
    } else {
      tabs.delete(tab);
    }
  },
  updateCwd: vi.fn(),
  updateGitIndicator: vi.fn(),
}));

vi.mock('../../state', () => ({
  sessionTerminals: new Map([
    [
      's1',
      {
        container: terminalContainer,
        terminal: { focus: focusSpy },
      },
    ],
  ]),
}));

vi.mock('../../stores', () => ({
  $isMainBrowser: {
    get: () => isMainBrowser,
  },
  $processStates: {
    get: () => ({}),
    subscribe: vi.fn(),
  },
  $sessionList: {
    get: () => sessionListMock,
    subscribe: vi.fn(),
  },
}));

vi.mock('../i18n', () => ({
  t: (key: string) =>
    (
      ({
        'session.terminal': 'Terminal',
        'sessionTabs.agent': 'Lens',
        'sessionTabs.files': 'Files',
        'sessionLauncher.codexTitle': 'Codex',
        'sessionLauncher.claudeTitle': 'Claude',
      }) as Record<string, string>
    )[key] ?? key,
}));

vi.mock('../layout/layoutStore', () => ({
  isSessionInLayout: () => false,
}));

vi.mock('../terminal/scaling', () => ({
  applyTerminalScalingSync: applyTerminalScalingSyncSpy,
  fitSessionToScreen: fitSessionToScreenSpy,
  fitTerminalToContainer: vi.fn(),
  refreshTerminalPresentation: refreshTerminalPresentationSpy,
}));

describe('tabManager', () => {
  beforeEach(() => {
    focusSpy.mockReset();
    refreshTerminalPresentationSpy.mockReset();
    applyTerminalScalingSyncSpy.mockReset();
    fitSessionToScreenSpy.mockReset();
    isMainBrowser = false;
    sessionListMock = [
      {
        id: 's1',
        agentControlled: false,
        hasLensHistory: false,
        lensOnly: false,
        supervisor: { profile: 'shell' },
      },
    ];
    terminalContainer.children.length = 0;
    visibleTabs.clear();
    vi.resetModules();
    vi.stubGlobal('document', {
      createElement: () => createMockElement(),
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it('keeps the terminal container inside the terminal panel while files view is active', async () => {
    const { ensureSessionWrapper, getTabPanel, switchTab, getActiveTab } =
      await import('./tabManager');

    ensureSessionWrapper('s1');
    const terminalPanel = getTabPanel('s1', 'terminal');
    const filesPanel = getTabPanel('s1', 'files');

    expect(terminalPanel?.children).toContain(terminalContainer);

    switchTab('s1', 'files');

    expect(getActiveTab('s1')).toBe('files');
    expect(terminalPanel?.children).toContain(terminalContainer);
    expect(filesPanel?.children).not.toContain(terminalContainer);
    expect(terminalPanel?.classList.remove).toHaveBeenCalledWith('active');
    expect(filesPanel?.classList.add).toHaveBeenCalledWith('active');

    switchTab('s1', 'terminal');

    expect(getActiveTab('s1')).toBe('terminal');
    expect(refreshTerminalPresentationSpy).toHaveBeenCalledWith('s1', expect.anything());
    expect(applyTerminalScalingSyncSpy).toHaveBeenCalledWith(expect.anything());
    expect(fitSessionToScreenSpy).not.toHaveBeenCalled();
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('refits standalone terminals when the main browser shows the terminal tab', async () => {
    isMainBrowser = true;
    const { ensureSessionWrapper, switchTab } = await import('./tabManager');

    ensureSessionWrapper('s1');
    switchTab('s1', 'files');
    switchTab('s1', 'terminal');

    expect(fitSessionToScreenSpy).toHaveBeenCalledWith('s1');
    expect(applyTerminalScalingSyncSpy).not.toHaveBeenCalled();
  });

  it('keeps terminal sessions terminal-only and ignores hidden agent switches', async () => {
    const { ensureSessionWrapper, switchTab, getActiveTab, isTabAvailable } =
      await import('./tabManager');

    ensureSessionWrapper('s1');

    expect(isTabAvailable('s1', 'agent')).toBe(false);
    expect(getActiveTab('s1')).toBe('terminal');

    switchTab('s1', 'agent');

    expect(getActiveTab('s1')).toBe('terminal');
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('makes lens-backed sessions agent-only and uses provider-specific labels', async () => {
    sessionListMock = [
      {
        id: 's1',
        agentControlled: true,
        hasLensHistory: true,
        lensOnly: true,
        supervisor: { profile: 'codex' },
      },
    ];
    const { ensureSessionWrapper, getActiveTab, getTabLabelForSession, isTabAvailable } =
      await import('./tabManager');

    ensureSessionWrapper('s1');

    expect(isTabAvailable('s1', 'agent')).toBe(true);
    expect(getActiveTab('s1')).toBe('agent');
    expect(isTabAvailable('s1', 'terminal')).toBe(false);
    expect(getTabLabelForSession('s1', 'agent')).toBe('Codex');
  });

  it('lets forced lens availability claim the primary surface before metadata catches up', async () => {
    const { ensureSessionWrapper, getActiveTab, isTabAvailable, setSessionLensAvailability } =
      await import('./tabManager');

    ensureSessionWrapper('s1');

    setSessionLensAvailability('s1', true);

    expect(isTabAvailable('s1', 'terminal')).toBe(false);
    expect(isTabAvailable('s1', 'agent')).toBe(true);
    expect(getActiveTab('s1')).toBe('agent');

    setSessionLensAvailability('s1', false);

    expect(isTabAvailable('s1', 'agent')).toBe(false);
    expect(isTabAvailable('s1', 'terminal')).toBe(true);
    expect(getActiveTab('s1')).toBe('terminal');
  });

  it('invokes every registered callback for tab activation and deactivation', async () => {
    const { ensureSessionWrapper, onTabActivated, onTabDeactivated, switchTab } =
      await import('./tabManager');

    const activatedA = vi.fn();
    const activatedB = vi.fn();
    const deactivatedA = vi.fn();
    const deactivatedB = vi.fn();

    onTabActivated('agent', activatedA);
    onTabActivated('agent', activatedB);
    onTabDeactivated('agent', deactivatedA);
    onTabDeactivated('agent', deactivatedB);

    sessionListMock = [
      {
        id: 's1',
        agentControlled: true,
        hasLensHistory: true,
        lensOnly: true,
        supervisor: { profile: 'claude' },
      },
    ];
    ensureSessionWrapper('s1');
    switchTab('s1', 'files');
    switchTab('s1', 'agent');

    expect(activatedA).toHaveBeenCalledTimes(1);
    expect(activatedB).toHaveBeenCalledTimes(1);
    expect(deactivatedA).toHaveBeenCalledTimes(1);
    expect(deactivatedB).toHaveBeenCalledTimes(1);
  });

  it('keeps Lens available for agent sessions without any dev-mode gate', async () => {
    sessionListMock = [
      {
        id: 's1',
        agentControlled: true,
        hasLensHistory: true,
        lensOnly: false,
        supervisor: { profile: 'claude' },
      },
    ];
    const { ensureSessionWrapper, isTabAvailable, getActiveTab } = await import('./tabManager');

    ensureSessionWrapper('s1');

    expect(isTabAvailable('s1', 'agent')).toBe(true);
    expect(getActiveTab('s1')).toBe('agent');
    expect(isTabAvailable('s1', 'terminal')).toBe(false);
  });
});
