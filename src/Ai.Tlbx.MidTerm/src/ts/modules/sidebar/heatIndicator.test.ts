import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface HeatElementMock {
  style: {
    setProperty: ReturnType<typeof vi.fn>;
  };
}

function createHeatElementMock(): HeatElementMock {
  return {
    style: {
      setProperty: vi.fn(),
    },
  };
}

const getSessionsMock = vi.hoisted(() => vi.fn());

vi.mock('../../api/client', () => ({
  getSessions: getSessionsMock,
}));

vi.mock('../logging', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

let destroyHeatIndicator: typeof import('./heatIndicator').destroyHeatIndicator;
let getDisplayedSessionHeat: typeof import('./heatIndicator').getDisplayedSessionHeat;
let getSessionHeat: typeof import('./heatIndicator').getSessionHeat;
let initHeatIndicator: typeof import('./heatIndicator').initHeatIndicator;
let pruneHeatSessions: typeof import('./heatIndicator').pruneHeatSessions;
let registerHeatCanvas: typeof import('./heatIndicator').registerHeatCanvas;
let setSessionHeat: typeof import('./heatIndicator').setSessionHeat;
let unregisterHeatCanvas: typeof import('./heatIndicator').unregisterHeatCanvas;
const heatIndicatorModulePromise = import('./heatIndicator');

describe('heatIndicator', () => {
  let nowMs = Date.parse('2026-03-24T12:00:00.000Z');
  let intervalCallbacks = new Map<number, () => void>();
  let nextIntervalId = 1;
  let visibilityChangeListeners: Array<() => void> = [];
  let windowEventListeners = new Map<string, Array<() => void>>();
  let documentMock: { hidden: boolean; addEventListener: ReturnType<typeof vi.fn> };

  async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  function advanceTime(durationMs: number): void {
    nowMs += durationMs;
  }

  async function runIntervalTick(id: number = 1): Promise<void> {
    intervalCallbacks.get(id)?.();
    await flushPromises();
  }

  async function advancePolls(durationMs: number, stepMs: number = 1000): Promise<void> {
    const iterations = Math.floor(durationMs / stepMs);
    for (let i = 0; i < iterations; i += 1) {
      advanceTime(stepMs);
      await runIntervalTick();
    }

    const remainder = durationMs - iterations * stepMs;
    if (remainder > 0) {
      advanceTime(remainder);
    }
  }

  function setDocumentHidden(hidden: boolean): void {
    documentMock.hidden = hidden;
    visibilityChangeListeners.forEach((listener) => listener());
  }

  function buildSessionsResponse(
    sessions: Array<{ id: string; currentHeat: number; lastOutputAt?: string | null }>,
  ) {
    return {
      data: {
        sessions: sessions.map((session) => ({
          id: session.id,
          supervisor: {
            currentHeat: session.currentHeat,
            lastOutputAt: session.lastOutputAt ?? null,
          },
        })),
      },
      response: {
        ok: true,
      },
    };
  }

  beforeAll(async () => {
    ({
      destroyHeatIndicator,
      getDisplayedSessionHeat,
      getSessionHeat,
      initHeatIndicator,
      pruneHeatSessions,
      registerHeatCanvas,
      setSessionHeat,
      unregisterHeatCanvas,
    } = await heatIndicatorModulePromise);
  });

  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    getSessionsMock.mockReset();
    getSessionsMock.mockImplementation(async () => buildSessionsResponse([]));

    intervalCallbacks = new Map<number, () => void>();
    nextIntervalId = 1;
    visibilityChangeListeners = [];
    windowEventListeners = new Map<string, Array<() => void>>();
    nowMs = Date.parse('2026-03-24T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    documentMock = {
      hidden: false,
      addEventListener: vi.fn((event: string, callback: () => void) => {
        if (event === 'visibilitychange') {
          visibilityChangeListeners.push(callback);
        }
      }),
    };

    vi.stubGlobal('window', {
      addEventListener: vi.fn((event: string, callback: () => void) => {
        const listeners = windowEventListeners.get(event) ?? [];
        listeners.push(callback);
        windowEventListeners.set(event, listeners);
      }),
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
      })),
      setInterval: vi.fn((callback: () => void) => {
        const id = nextIntervalId++;
        intervalCallbacks.set(id, callback);
        return id;
      }),
      clearInterval: vi.fn((id: number) => {
        intervalCallbacks.delete(id);
      }),
    });
    vi.stubGlobal('document', documentMock);
    destroyHeatIndicator();
  });

  afterEach(() => {
    destroyHeatIndicator();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves heat state across sidebar rerenders', () => {
    const firstElement = createHeatElementMock();
    registerHeatCanvas('session-1', firstElement as unknown as HTMLElement);

    setSessionHeat('session-1', 0.8);
    advanceTime(300);
    const heatBeforeRerender = getSessionHeat('session-1');
    const displayedBeforeRerender = getDisplayedSessionHeat('session-1');

    expect(heatBeforeRerender).toBeGreaterThan(0);
    expect(displayedBeforeRerender).toBeGreaterThan(0.7);

    unregisterHeatCanvas('session-1');
    expect(getSessionHeat('session-1')).toBeCloseTo(heatBeforeRerender, 5);

    const secondElement = createHeatElementMock();
    registerHeatCanvas('session-1', secondElement as unknown as HTMLElement);

    expect(getSessionHeat('session-1')).toBeCloseTo(heatBeforeRerender, 5);
    expect(getDisplayedSessionHeat('session-1')).toBeCloseTo(displayedBeforeRerender, 3);
    expect(secondElement.style.setProperty).toHaveBeenCalled();
  });

  it('drops heat state only when the session is pruned', () => {
    const element = createHeatElementMock();
    registerHeatCanvas('session-1', element as unknown as HTMLElement);

    setSessionHeat('session-1', 0.6);
    advanceTime(300);
    expect(getSessionHeat('session-1')).toBeGreaterThan(0);

    pruneHeatSessions([]);
    expect(getSessionHeat('session-1')).toBe(0);
  });

  it('smoothly animates rendered heat toward the latest target', () => {
    const element = createHeatElementMock();
    registerHeatCanvas('session-1', element as unknown as HTMLElement);

    setSessionHeat('session-1', 1);

    expect(getSessionHeat('session-1')).toBe(1);
    expect(getDisplayedSessionHeat('session-1')).toBe(0);

    advanceTime(300);

    expect(getDisplayedSessionHeat('session-1')).toBeGreaterThan(0.9);
    expect(element.style.setProperty).toHaveBeenCalled();
  });

  it('decays slowly enough to preserve a visible session hierarchy', async () => {
    const element = createHeatElementMock();
    registerHeatCanvas('session-1', element as unknown as HTMLElement);
    initHeatIndicator();

    setSessionHeat('session-1', 1);
    advanceTime(300);
    expect(getDisplayedSessionHeat('session-1')).toBeGreaterThan(0.9);

    setSessionHeat('session-1', 0);
    await advancePolls(42_000);
    expect(getDisplayedSessionHeat('session-1')).toBeCloseTo(0.25, 1);

    await advancePolls(126_000);
    expect(getDisplayedSessionHeat('session-1')).toBeLessThan(0.01);
    expect(getDisplayedSessionHeat('session-1')).toBeGreaterThan(0);
  });

  it('recomputes decayed heat from elapsed time when returning from the background', async () => {
    const element = createHeatElementMock();
    registerHeatCanvas('session-1', element as unknown as HTMLElement);
    initHeatIndicator();

    setSessionHeat('session-1', 1);
    advanceTime(300);
    expect(getDisplayedSessionHeat('session-1')).toBeGreaterThan(0.9);

    setDocumentHidden(true);
    advanceTime(42_000);
    setDocumentHidden(false);
    await flushPromises();

    expect(getDisplayedSessionHeat('session-1')).toBeCloseTo(0.25, 1);
    expect(element.style.setProperty).toHaveBeenCalled();
  });

  it('does not create heat from zero-heat refreshes that only carry last output timestamps', async () => {
    getSessionsMock.mockResolvedValue(
      buildSessionsResponse([
        {
          id: 'session-1',
          currentHeat: 0,
          lastOutputAt: new Date(nowMs).toISOString(),
        },
      ]),
    );

    const element = createHeatElementMock();
    registerHeatCanvas('session-1', element as unknown as HTMLElement);
    initHeatIndicator();
    await flushPromises();

    expect(getSessionHeat('session-1')).toBe(0);
    expect(getDisplayedSessionHeat('session-1')).toBe(0);
    expect(element.style.setProperty).toHaveBeenCalled();
  });

  it('continues polling while the document is hidden', async () => {
    getSessionsMock.mockResolvedValue(
      buildSessionsResponse([
        {
          id: 'session-1',
          currentHeat: 1,
          lastOutputAt: new Date(nowMs).toISOString(),
        },
      ]),
    );

    const element = createHeatElementMock();
    registerHeatCanvas('session-1', element as unknown as HTMLElement);
    initHeatIndicator();
    await flushPromises();

    getSessionsMock.mockClear();
    setDocumentHidden(true);

    await runIntervalTick();

    expect(getSessionsMock).toHaveBeenCalledTimes(1);
    expect(getSessionHeat('session-1')).toBe(1);
  });
});
