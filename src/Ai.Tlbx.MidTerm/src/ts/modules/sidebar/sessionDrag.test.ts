import { beforeEach, describe, expect, it, vi } from 'vitest';

type ListenerMap = Record<string, (event: any) => void>;

const sessionListListeners: ListenerMap = {};
const documentListeners: ListenerMap = {};
const showDockOverlay = vi.fn();

const layoutRootClasses = new Set<string>(['hidden']);
const standaloneClasses = new Set<string>();

const sessionList = {
  addEventListener(type: string, listener: (event: any) => void): void {
    sessionListListeners[type] = listener;
  },
};

const terminalsArea = {
  getBoundingClientRect(): DOMRect {
    return {
      left: 100,
      top: 100,
      right: 500,
      bottom: 400,
      width: 400,
      height: 300,
      x: 100,
      y: 100,
      toJSON(): Record<string, never> {
        return {};
      },
    } as DOMRect;
  },
};

const layoutRoot = {
  classList: {
    contains(name: string): boolean {
      return layoutRootClasses.has(name);
    },
    remove(name: string): void {
      layoutRootClasses.delete(name);
    },
    add(name: string): void {
      layoutRootClasses.add(name);
    },
  },
};

const sessionItem = {
  dataset: {
    sessionId: 'dragged',
    controlMode: 'human',
  },
  classList: {
    add: vi.fn(),
    remove: vi.fn(),
  },
  offsetWidth: 240,
  offsetHeight: 48,
  cloneNode(): any {
    return {
      style: {},
      classList: {
        remove: vi.fn(),
      },
      remove: vi.fn(),
    };
  },
  closest(selector: string): any {
    return selector === '.session-item' ? sessionItem : null;
  },
};

vi.mock('../../state', () => ({
  dom: {
    sessionList,
    terminalsArea,
  },
  sessionTerminals: new Map([
    [
      'layout-a',
      {
        container: {
          classList: {
            add: vi.fn(),
            remove: vi.fn(),
          },
        },
      },
    ],
    [
      'solo',
      {
        container: {
          classList: {
            add(name: string): void {
              standaloneClasses.add(name);
            },
            remove(name: string): void {
              standaloneClasses.delete(name);
            },
          },
        },
      },
    ],
  ]),
}));

vi.mock('../../stores', () => ({
  reorderSessions: vi.fn(),
  $sessionList: {
    get: () => [],
  },
  $activeSessionId: {
    get: () => 'solo',
  },
}));

vi.mock('../comms', () => ({
  persistSessionOrder: vi.fn(),
}));

vi.mock('./sessionList', () => ({
  isSessionFilterActive: () => false,
}));

vi.mock('../layout/dockOverlay', () => ({
  showDockOverlay,
  hideDockOverlay: vi.fn(),
  getDockTarget: vi.fn(() => null),
  isDockOverlayVisible: vi.fn(() => false),
}));

vi.mock('../layout/layoutStore', () => ({
  dockSession: vi.fn(),
  isLayoutActive: () => true,
  isSessionInLayout: (sessionId: string) => sessionId === 'layout-a',
}));

vi.mock('../layout/layoutRenderer', () => ({
  getLayoutRoot: () => layoutRoot,
}));

describe('sessionDrag', () => {
  beforeEach(() => {
    for (const key of Object.keys(sessionListListeners)) {
      delete sessionListListeners[key];
    }
    for (const key of Object.keys(documentListeners)) {
      delete documentListeners[key];
    }
    layoutRootClasses.clear();
    layoutRootClasses.add('hidden');
    standaloneClasses.clear();
    showDockOverlay.mockReset();

    class FakeHTMLElement {}
    vi.stubGlobal('HTMLElement', FakeHTMLElement);
    Object.setPrototypeOf(sessionItem, FakeHTMLElement.prototype);

    vi.stubGlobal('document', {
      addEventListener(type: string, listener: (event: any) => void): void {
        documentListeners[type] = listener;
      },
      body: {
        appendChild: vi.fn(),
      },
    });
  });

  it('reveals a hidden layout preview before dock hit-testing over the terminals area', async () => {
    vi.resetModules();
    const { initSessionDrag } = await import('./sessionDrag');

    initSessionDrag();

    sessionListListeners.dragstart?.({
      target: sessionItem,
      dataTransfer: {
        effectAllowed: '',
        setData: vi.fn(),
        setDragImage: vi.fn(),
      },
    });

    const preventDefault = vi.fn();
    documentListeners.dragover?.({
      clientX: 160,
      clientY: 180,
      preventDefault,
      dataTransfer: {
        dropEffect: 'none',
      },
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(layoutRootClasses.has('hidden')).toBe(false);
    expect(standaloneClasses.has('hidden')).toBe(true);
    expect(showDockOverlay).toHaveBeenCalledWith(160, 180, 'dragged');
  });
});
