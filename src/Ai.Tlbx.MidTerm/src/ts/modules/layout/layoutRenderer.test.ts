import { beforeEach, describe, expect, it, vi } from 'vitest';

let layoutActive = false;
let terminalsArea: { querySelectorAll: (selector: string) => unknown[] } | null = null;
let wrappersBySession = new Map<string, any>();

function makeRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON(): Record<string, never> {
      return {};
    },
  } as DOMRect;
}

vi.mock('../../state', () => ({
  dom: {
    get terminalsArea() {
      return terminalsArea;
    },
  },
  sessionTerminals: new Map(),
  suppressLayoutAutoFit: false,
  setSuppressLayoutAutoFit: vi.fn(),
}));

vi.mock('../../stores', () => ({
  $layout: { subscribe: vi.fn() },
  $focusedSessionId: { subscribe: vi.fn() },
  $activeSessionId: { get: vi.fn(() => null) },
  $isMainBrowser: { get: vi.fn(() => true) },
}));

vi.mock('./layoutStore', () => ({
  isLayoutActive: () => layoutActive,
  focusLayoutSession: vi.fn(),
}));

vi.mock('../terminal/scaling', () => ({
  applyTerminalScalingSync: vi.fn(),
  fitTerminalToContainer: vi.fn(),
  fitSessionToScreen: vi.fn(),
}));

vi.mock('../smartInput', () => ({
  isSmartInputMode: vi.fn(() => false),
  showSmartInput: vi.fn(),
}));

vi.mock('../sessionTabs', () => ({
  ensureSessionWrapper: vi.fn(),
  getActiveTab: vi.fn(() => 'terminal'),
  getSessionWrapper: (sessionId: string) => wrappersBySession.get(sessionId) ?? null,
  reparentTerminalContainer: vi.fn(),
}));

describe('layoutRenderer dock target geometry', () => {
  beforeEach(() => {
    vi.resetModules();
    layoutActive = false;
    terminalsArea = null;
    wrappersBySession = new Map();
    vi.stubGlobal('document', {
      getElementById: vi.fn(() => null),
    });
  });

  it('uses the visible active session panel for standalone dock overlay geometry', async () => {
    const panelRect = makeRect(12, 40, 640, 420);
    const wrapper = {
      dataset: { sessionId: 'lens-session' },
      classList: { contains: vi.fn(() => false) },
      querySelector: (selector: string) =>
        selector === '.session-tab-panel.active'
          ? {
              getBoundingClientRect: () => panelRect,
            }
          : null,
      getBoundingClientRect: () => makeRect(12, 0, 640, 460),
    };
    wrappersBySession.set('lens-session', wrapper);
    terminalsArea = {
      querySelectorAll: (selector: string) =>
        selector === '.session-wrapper:not(.hidden)' ? [wrapper] : [],
    };

    const { findSessionAtPoint, getSessionPaneRect } = await import('./layoutRenderer');

    expect(findSessionAtPoint(24, 64)).toBe('lens-session');
    expect(getSessionPaneRect('lens-session')).toBe(panelRect);
  });

  it('falls back to legacy visible terminal containers when no wrapper exists', async () => {
    const terminalRect = makeRect(4, 8, 300, 240);
    const container = {
      id: 'terminal-standalone',
      getBoundingClientRect: () => terminalRect,
    };
    terminalsArea = {
      querySelectorAll: (selector: string) =>
        selector === '.terminal-container:not(.hidden)' ? [container] : [],
    };
    vi.stubGlobal('document', {
      getElementById: vi.fn(() => ({
        classList: { contains: vi.fn(() => false) },
        getBoundingClientRect: () => terminalRect,
      })),
    });

    const { findSessionAtPoint, getSessionPaneRect } = await import('./layoutRenderer');

    expect(findSessionAtPoint(20, 20)).toBe('standalone');
    expect(getSessionPaneRect('standalone')).toBe(terminalRect);
  });
});
