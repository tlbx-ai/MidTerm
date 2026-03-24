import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeContext {
  scale: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  createLinearGradient: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  arcTo: ReturnType<typeof vi.fn>;
  closePath: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  fillStyle: unknown;
}

function createCanvasMock() {
  const gradient = { addColorStop: vi.fn() };
  const ctx: FakeContext = {
    scale: vi.fn(),
    clearRect: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillStyle: null,
  };

  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
  };

  return { canvas: canvas as any, ctx, gradient };
}

describe('heatIndicator', () => {
  let rafQueue: FrameRequestCallback[] = [];
  let nowMs = Date.parse('2026-03-24T12:00:00.000Z');
  let intervalCallbacks = new Map<number, () => void>();
  let nextIntervalId = 1;
  let visibilityChangeListeners: Array<() => void> = [];
  let documentMock: { hidden: boolean; addEventListener: ReturnType<typeof vi.fn> };
  let getSessionsMock: ReturnType<typeof vi.fn>;

  async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  function advanceAnimationFrames(durationMs: number, stepMs: number = 16): void {
    const deadline = nowMs + durationMs;
    while (rafQueue.length > 0 && nowMs < deadline) {
      const callbacks = [...rafQueue];
      rafQueue = [];
      nowMs = Math.min(deadline, nowMs + stepMs);
      callbacks.forEach((callback) => callback(stepMs));
    }
  }

  function advanceTimeWithoutFrames(durationMs: number): void {
    nowMs += durationMs;
  }

  function setDocumentHidden(hidden: boolean): void {
    documentMock.hidden = hidden;
    visibilityChangeListeners.forEach((listener) => listener());
  }

  async function runIntervalTick(id: number = 1): Promise<void> {
    intervalCallbacks.get(id)?.();
    await flushPromises();
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

  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();

    getSessionsMock = vi.fn(async () => buildSessionsResponse([]));
    vi.doMock('../../api/client', () => ({
      getSessions: getSessionsMock,
    }));

    rafQueue = [];
    intervalCallbacks = new Map<number, () => void>();
    nextIntervalId = 1;
    visibilityChangeListeners = [];
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
      devicePixelRatio: 1,
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
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        rafQueue.push(callback);
        return rafQueue.length;
      }),
      cancelAnimationFrame: vi.fn(() => {
        rafQueue = [];
      }),
    });
    vi.stubGlobal('document', documentMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves heat state across sidebar rerenders', async () => {
    const module = await import('./heatIndicator');
    const firstCanvas = createCanvasMock();
    module.registerHeatCanvas('session-1', firstCanvas.canvas);

    module.setSessionHeat('session-1', 0.8);
    advanceAnimationFrames(300);
    const heatBeforeRerender = module.getSessionHeat('session-1');
    expect(heatBeforeRerender).toBeGreaterThan(0);

    module.unregisterHeatCanvas('session-1');
    expect(module.getSessionHeat('session-1')).toBeCloseTo(heatBeforeRerender, 5);

    const secondCanvas = createCanvasMock();
    module.registerHeatCanvas('session-1', secondCanvas.canvas);

    expect(module.getSessionHeat('session-1')).toBeCloseTo(heatBeforeRerender, 5);
    expect(secondCanvas.ctx.fill).toHaveBeenCalled();
  });

  it('drops heat state only when the session is pruned', async () => {
    const module = await import('./heatIndicator');
    const canvas = createCanvasMock();
    module.registerHeatCanvas('session-1', canvas.canvas);

    module.setSessionHeat('session-1', 0.6);
    advanceAnimationFrames(300);
    expect(module.getSessionHeat('session-1')).toBeGreaterThan(0);

    module.pruneHeatSessions([]);
    expect(module.getSessionHeat('session-1')).toBe(0);
  });

  it('smoothly animates rendered heat toward the latest target', async () => {
    const module = await import('./heatIndicator');
    const canvas = createCanvasMock();
    module.registerHeatCanvas('session-1', canvas.canvas);

    module.setSessionHeat('session-1', 1);

    expect(module.getSessionHeat('session-1')).toBe(1);
    expect(module.getDisplayedSessionHeat('session-1')).toBe(0);

    advanceAnimationFrames(300);

    expect(module.getDisplayedSessionHeat('session-1')).toBeGreaterThan(0.9);
    expect(canvas.ctx.fill.mock.calls.length).toBeGreaterThan(1);
  });

  it('decays slowly enough to preserve a visible session hierarchy', async () => {
    const module = await import('./heatIndicator');
    const canvas = createCanvasMock();
    module.registerHeatCanvas('session-1', canvas.canvas);

    module.setSessionHeat('session-1', 1);
    advanceAnimationFrames(300);
    expect(module.getDisplayedSessionHeat('session-1')).toBeGreaterThan(0.9);

    module.setSessionHeat('session-1', 0);
    advanceAnimationFrames(42_000);
    expect(module.getDisplayedSessionHeat('session-1')).toBeCloseTo(0.25, 1);

    advanceAnimationFrames(126_000);
    expect(module.getDisplayedSessionHeat('session-1')).toBeLessThan(0.01);
    expect(module.getDisplayedSessionHeat('session-1')).toBeGreaterThan(0);
  });

  it('recomputes decayed heat from elapsed time when returning from the background', async () => {
    const module = await import('./heatIndicator');
    const canvas = createCanvasMock();
    module.registerHeatCanvas('session-1', canvas.canvas);
    module.initHeatIndicator();

    module.setSessionHeat('session-1', 1);
    advanceAnimationFrames(300);
    expect(module.getDisplayedSessionHeat('session-1')).toBeGreaterThan(0.9);

    setDocumentHidden(true);
    expect(rafQueue).toHaveLength(0);

    advanceTimeWithoutFrames(42_000);
    setDocumentHidden(false);

    expect(module.getDisplayedSessionHeat('session-1')).toBeCloseTo(0.25, 1);
    expect(canvas.ctx.fill).toHaveBeenCalled();
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

    const module = await import('./heatIndicator');
    const canvas = createCanvasMock();
    module.registerHeatCanvas('session-1', canvas.canvas);
    module.initHeatIndicator();
    await flushPromises();

    expect(module.getSessionHeat('session-1')).toBe(0);
    expect(module.getDisplayedSessionHeat('session-1')).toBe(0);
    expect(canvas.ctx.fill).not.toHaveBeenCalled();
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

    const module = await import('./heatIndicator');
    const canvas = createCanvasMock();
    module.registerHeatCanvas('session-1', canvas.canvas);
    module.initHeatIndicator();
    await flushPromises();

    getSessionsMock.mockClear();
    setDocumentHidden(true);

    await runIntervalTick();

    expect(getSessionsMock).toHaveBeenCalledTimes(1);
    expect(module.getSessionHeat('session-1')).toBe(1);
  });
});
