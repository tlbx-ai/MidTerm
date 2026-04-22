import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types';

let domRef: typeof import('../../state').dom | null = null;
let syncDisplayText: typeof import('./spacesTreeSidebarDisplay').syncSidebarSessionDisplayText;

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

  domRef = (await import('../../state')).dom;
  syncDisplayText = (await import('./spacesTreeSidebarDisplay')).syncSidebarSessionDisplayText;
});

afterEach(() => {
  if (domRef) {
    domRef.sessionList = null;
  }
  vi.unstubAllGlobals();
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
});
