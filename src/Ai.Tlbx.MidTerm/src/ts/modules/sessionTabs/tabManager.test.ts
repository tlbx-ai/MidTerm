import { beforeEach, describe, expect, it, vi } from 'vitest';

const focusSpy = vi.fn();
const refreshTerminalPresentationSpy = vi.fn();
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
  isTabVisible: (bar: HTMLDivElement, tab: string) => visibleTabs.get(bar.dataset.sessionId ?? '')?.has(tab) ?? false,
  setActiveTab: vi.fn(),
  setActionActive: vi.fn(),
  setActionVisible: vi.fn(),
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
    get: () => false,
  },
  $processStates: {
    get: () => ({}),
    subscribe: vi.fn(),
  },
  $sessionList: {
    get: () => [
      {
        id: 's1',
        agentControlled: true,
        supervisor: { profile: 'codex' },
      },
    ],
    subscribe: vi.fn(),
  },
}));

vi.mock('../layout/layoutStore', () => ({
  isSessionInLayout: () => false,
}));

vi.mock('../terminal/scaling', () => ({
  applyTerminalScalingSync: vi.fn(),
  fitTerminalToContainer: vi.fn(),
  refreshTerminalPresentation: refreshTerminalPresentationSpy,
}));

describe('tabManager', () => {
  beforeEach(() => {
    focusSpy.mockReset();
    refreshTerminalPresentationSpy.mockReset();
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

  it('keeps the terminal container inside the terminal panel while agent view is active', async () => {
    const { ensureSessionWrapper, getTabPanel, switchTab, getActiveTab } = await import('./tabManager');

    ensureSessionWrapper('s1');
    const terminalPanel = getTabPanel('s1', 'terminal');
    const agentPanel = getTabPanel('s1', 'agent');

    expect(terminalPanel?.children).toContain(terminalContainer);

    switchTab('s1', 'agent');

    expect(getActiveTab('s1')).toBe('agent');
    expect(terminalPanel?.children).toContain(terminalContainer);
    expect(agentPanel?.children).not.toContain(terminalContainer);
    expect(terminalPanel?.classList.remove).toHaveBeenCalledWith('active');
    expect(agentPanel?.classList.add).toHaveBeenCalledWith('active');

    switchTab('s1', 'terminal');

    expect(getActiveTab('s1')).toBe('terminal');
    expect(refreshTerminalPresentationSpy).toHaveBeenCalledWith('s1', expect.anything());
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to terminal when the agent tab disappears and ignores hidden tab switches', async () => {
    const { ensureSessionWrapper, switchTab, syncSessionTabCapabilities, getActiveTab, isTabAvailable } =
      await import('./tabManager');

    ensureSessionWrapper('s1');
    switchTab('s1', 'agent');
    expect(getActiveTab('s1')).toBe('agent');

    syncSessionTabCapabilities('s1', {
      id: 's1',
      agentControlled: false,
      supervisor: { profile: 'shell' },
    } as any);

    expect(isTabAvailable('s1', 'agent')).toBe(false);
    expect(getActiveTab('s1')).toBe('terminal');

    switchTab('s1', 'agent');

    expect(getActiveTab('s1')).toBe('terminal');
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps Lens available when canonical Lens history exists', async () => {
    const { ensureSessionWrapper, switchTab, syncSessionTabCapabilities, getActiveTab, isTabAvailable } =
      await import('./tabManager');

    ensureSessionWrapper('s1');

    syncSessionTabCapabilities('s1', {
      id: 's1',
      agentControlled: false,
      hasLensHistory: true,
      supervisor: { profile: 'shell' },
    } as any);

    expect(isTabAvailable('s1', 'agent')).toBe(true);
    switchTab('s1', 'agent');

    expect(getActiveTab('s1')).toBe('agent');
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

    ensureSessionWrapper('s1');
    switchTab('s1', 'agent');
    switchTab('s1', 'terminal');

    expect(activatedA).toHaveBeenCalledTimes(1);
    expect(activatedB).toHaveBeenCalledTimes(1);
    expect(deactivatedA).toHaveBeenCalledTimes(1);
    expect(deactivatedB).toHaveBeenCalledTimes(1);
  });
});
