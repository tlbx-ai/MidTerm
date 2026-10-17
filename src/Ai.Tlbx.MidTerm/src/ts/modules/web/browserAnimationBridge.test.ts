import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(
  new URL('../../../../Services/WebPreview/WebPreviewProxyMiddleware.cs', import.meta.url),
  'utf8',
);
const animation = source.slice(
  source.indexOf('var mtNativeRaf='),
  source.indexOf('function curBwsState(){'),
);

function harness(background = true) {
  let nextId = 0;
  const native = new Map<number, (time: number) => void>();
  const timers: (() => void)[] = [];
  const window = {
    requestAnimationFrame: (callback: (time: number) => void) => {
      native.set(++nextId, callback);
      return nextId;
    },
    cancelAnimationFrame: (id: number) => native.delete(id),
  };
  const context = {
    window,
    document: { hidden: false, addEventListener: vi.fn() },
    performance: { now: () => 123 },
    bwsVisibleOverride: !background,
    mtNestedPreview: false,
    setTimeout: (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
  };
  runInNewContext(animation, context);
  return { window, context, native, timers, tick: () => timers.shift()?.() };
}

describe('background preview animation scheduling', () => {
  it.each(['loading', 'complete'])(
    'waits for a rendering opportunity after %s before reporting ready',
    (readyState) => {
      const frames: (() => void)[] = [];
      const send = vi.fn();
      let loaded = () => {};
      const branch = source.slice(
        source.indexOf('case"ready":{'),
        source.indexOf('case"clearcookies":{'),
      );
      const dispatch = new Function(
        'document',
        'requestAnimationFrame',
        'bws',
        'WebSocket',
        'curU',
        `var res={success:true};switch("ready"){${branch}}`,
      );
      dispatch(
        {
          readyState,
          addEventListener: (_: string, callback: () => void) => {
            loaded = callback;
          },
        },
        (callback: () => void) => frames.push(callback),
        { readyState: 1, send },
        { OPEN: 1 },
        () => 'https://example.test/',
      );
      expect(send).not.toHaveBeenCalled();
      if (readyState === 'loading') {
        expect(frames).toHaveLength(0);
        loaded();
      }
      expect(send).not.toHaveBeenCalled();
      frames.shift()?.();
      expect(send).toHaveBeenCalledExactlyOnceWith(
        '{"success":true,"result":"https://example.test/"}',
      );
    },
  );

  it('runs stalled rendering and schedules recursive work in the next batch', () => {
    const h = harness();
    const calls: number[] = [];
    h.window.requestAnimationFrame((time) => {
      calls.push(time);
      h.window.requestAnimationFrame((next) => calls.push(next));
    });
    h.tick();
    expect(calls).toEqual([123]);
    h.tick();
    expect(calls).toEqual([123, 123]);
    expect(h.native.size).toBe(0);
  });

  it('delivers each callback once when the native frame wins', () => {
    const h = harness();
    const callback = vi.fn();
    const id = h.window.requestAnimationFrame(callback);
    h.native.get(id)?.(99);
    h.tick();
    expect(callback).toHaveBeenCalledExactlyOnceWith(99);
  });

  it('honors cancellation including another callback in the same batch', () => {
    const h = harness();
    const callback = vi.fn();
    let cancelled = 0;
    h.window.requestAnimationFrame(() => h.window.cancelAnimationFrame(cancelled));
    cancelled = h.window.requestAnimationFrame(callback);
    h.tick();
    expect(callback).not.toHaveBeenCalled();
    expect(h.native.size).toBe(0);
  });

  it('leaves foreground rendering on the native scheduler', () => {
    const h = harness(false);
    const callback = vi.fn();
    const id = h.window.requestAnimationFrame(callback);
    expect(h.timers).toHaveLength(0);
    h.native.get(id)?.(42);
    expect(callback).toHaveBeenCalledExactlyOnceWith(42);
  });

  it('preserves the native window receiver for strict callbacks', () => {
    for (const background of [false, true]) {
      const h = harness(background);
      let receiver: unknown;
      const id = h.window.requestAnimationFrame(function (this: unknown) {
        receiver = this;
      });
      if (background) h.tick();
      else h.native.get(id)?.(42);
      expect(receiver).toBe(h.window);
    }
  });

  it('applies native numeric handle conversion when cancelling', () => {
    const h = harness();
    const callback = vi.fn();
    const id = h.window.requestAnimationFrame(callback);
    h.window.cancelAnimationFrame(String(id) as unknown as number);
    h.tick();
    expect(callback).not.toHaveBeenCalled();
  });

  it('stops the fallback when the preview becomes visible', () => {
    const h = harness();
    const callback = vi.fn();
    const id = h.window.requestAnimationFrame(callback);
    h.context.bwsVisibleOverride = true;
    h.tick();
    expect(callback).not.toHaveBeenCalled();
    h.native.get(id)?.(42);
    expect(callback).toHaveBeenCalledExactlyOnceWith(42);
  });
});
