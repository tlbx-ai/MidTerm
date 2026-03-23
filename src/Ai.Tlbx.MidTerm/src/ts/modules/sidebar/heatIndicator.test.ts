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

  function flushAnimationFrames(startTime: number = 16): void {
    let frameTime = startTime;
    while (rafQueue.length > 0) {
      const callbacks = [...rafQueue];
      rafQueue = [];
      callbacks.forEach((callback) => callback(frameTime));
      frameTime += 16;
    }
  }

  beforeEach(() => {
    vi.resetModules();
    rafQueue = [];

    vi.stubGlobal('window', {
      devicePixelRatio: 1,
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
      })),
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        rafQueue.push(callback);
        return rafQueue.length;
      }),
      cancelAnimationFrame: vi.fn(),
    });
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves heat state across sidebar rerenders', async () => {
    const module = await import('./heatIndicator');
    const firstCanvas = createCanvasMock();
    module.registerHeatCanvas('session-1', firstCanvas.canvas);

    module.setSessionHeat('session-1', 0.8);
    flushAnimationFrames();
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
    flushAnimationFrames();
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

    flushAnimationFrames();

    expect(module.getDisplayedSessionHeat('session-1')).toBeCloseTo(1, 2);
    expect(canvas.ctx.fill.mock.calls.length).toBeGreaterThan(1);
  });
});
