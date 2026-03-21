import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface RafCallback {
  (time: number): void;
}

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
  let nextRafId = 1;
  let scheduledFrame: RafCallback | null = null;

  beforeEach(() => {
    vi.resetModules();
    nextRafId = 1;
    scheduledFrame = null;

    vi.stubGlobal('window', {
      devicePixelRatio: 1,
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
      })),
    });
    vi.stubGlobal('document', {
      hidden: false,
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: RafCallback) => {
        scheduledFrame = cb;
        return nextRafId++;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves heat state across sidebar rerenders', async () => {
    const module = await import('./heatIndicator');
    const firstCanvas = createCanvasMock();
    module.registerHeatCanvas('session-1', firstCanvas.canvas);

    module.recordBytes('session-1', 1200);
    expect(scheduledFrame).not.toBeNull();
    scheduledFrame?.(performance.now() + 150);

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

    module.recordBytes('session-1', 1200);
    scheduledFrame?.(performance.now() + 150);
    expect(module.getSessionHeat('session-1')).toBeGreaterThan(0);

    module.pruneHeatSessions([]);
    expect(module.getSessionHeat('session-1')).toBe(0);
  });
});
