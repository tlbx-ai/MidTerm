import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types';

let domRef: typeof import('../../state').dom | null = null;
let syncDisplayText: typeof import('./spacesTreeSidebarDisplay').syncSidebarSessionDisplayText;
let syncActiveState: typeof import('./spacesTreeSidebarDisplay').syncSidebarActiveSessionState;

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 's1',
    name: null,
    terminalTitle: null,
    shellType: 'pwsh',
    lensOnly: false,
    ...overrides,
  } as Session;
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.doMock('./sessionList', () => ({
    getSessionDisplayInfo: (session: Session) => ({
      primary: session.name ?? session.terminalTitle ?? session.shellType ?? 'Terminal',
      secondary: session.name ? (session.terminalTitle ?? session.shellType ?? null) : null,
    }),
  }));

  domRef = (await import('../../state')).dom;
  const displayModule = await import('./spacesTreeSidebarDisplay');
  syncDisplayText = displayModule.syncSidebarSessionDisplayText;
  syncActiveState = displayModule.syncSidebarActiveSessionState;
});

afterEach(() => {
  if (domRef) {
    domRef.sessionList = null;
  }
  vi.unstubAllGlobals();
  vi.doUnmock('./sessionList');
  domRef = null;
});

describe('spaces tree sidebar display sync', () => {
  it('updates a terminal-title-only row without replacing the sidebar tree', () => {
    const title = { textContent: 'old title' };
    const titleRow = {};
    const item = {
      dataset: { sessionId: 's1' },
      querySelector: (selector: string) => {
        if (selector === '.session-title') return title;
        if (selector === '.session-title-row') return titleRow;
        if (selector === '.session-subtitle') return null;
        return null;
      },
    };
    const host = {
      querySelectorAll: (selector: string) =>
        selector === '.session-item[data-session-id]' ? [item] : [],
    };
    domRef!.sessionList = host as unknown as HTMLElement;

    expect(syncDisplayText(makeSession({ terminalTitle: 'Codex ⠋' }))).toBe(true);
    expect(title.textContent).toBe('Codex ⠋');
  });

  it('updates named-session subtitles in place when only the terminal title changes', () => {
    const title = { textContent: 'worker' };
    const subtitle = { textContent: 'old title', remove: () => {} };
    const titleRow = {};
    const item = {
      dataset: { sessionId: 's1' },
      querySelector: (selector: string) => {
        if (selector === '.session-title') return title;
        if (selector === '.session-title-row') return titleRow;
        if (selector === '.session-subtitle') return subtitle;
        return null;
      },
    };
    const host = {
      querySelectorAll: (selector: string) =>
        selector === '.session-item[data-session-id]' ? [item] : [],
    };
    domRef!.sessionList = host as unknown as HTMLElement;

    expect(
      syncDisplayText(makeSession({ name: 'worker', terminalTitle: 'Codex ⠙' })),
    ).toBe(true);
    expect(title.textContent).toBe('worker');
    expect(subtitle.textContent).toBe('Codex ⠙');
  });

  it('updates active row state without replacing sidebar items', () => {
    function makeItem(sessionId: string) {
      const classes = new Set<string>();
      const attributes = new Map<string, string>();
      return {
        dataset: { sessionId },
        classList: {
          toggle: (className: string, enabled: boolean) => {
            if (enabled) {
              classes.add(className);
            } else {
              classes.delete(className);
            }
          },
        },
        setAttribute: (name: string, value: string) => {
          attributes.set(name, value);
        },
        hasClass: (className: string) => classes.has(className),
        getAttributeValue: (name: string) => attributes.get(name),
      };
    }

    const first = makeItem('s1');
    const second = makeItem('s2');
    const host = {
      querySelectorAll: (selector: string) =>
        selector === '.session-item[data-session-id]' ? [first, second] : [],
    };
    domRef!.sessionList = host as unknown as HTMLElement;

    expect(syncActiveState('s2')).toBe(true);
    expect(first.hasClass('active')).toBe(false);
    expect(first.getAttributeValue('aria-current')).toBe('false');
    expect(second.hasClass('active')).toBe(true);
    expect(second.getAttributeValue('aria-current')).toBe('true');
  });
});
