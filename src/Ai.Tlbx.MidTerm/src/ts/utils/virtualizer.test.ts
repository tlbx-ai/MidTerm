import { describe, expect, it } from 'vitest';

import {
  computeVirtualWindow,
  resolveKernelWindowRequest,
  resolveScrollCompensationDelta,
  resolveViewportDrivenWindowCount,
} from './virtualizer';

describe('virtualizer', () => {
  it('computes a bounded overscanned render window', () => {
    const items = Array.from({ length: 100 }, (_, index) => index);

    const window = computeVirtualWindow({
      items,
      scrollTop: 500,
      clientHeight: 300,
      overscanItems: 2,
      resolveItemSize: () => 100,
    });

    expect(window).toEqual({
      start: 4,
      end: 11,
      topSpacerPx: 300,
      bottomSpacerPx: 8900,
    });
  });

  it('keeps a 10k item history render window bounded and spacer-backed', () => {
    const items = Array.from({ length: 10000 }, (_, index) => index);

    const window = computeVirtualWindow({
      items,
      scrollTop: 420000,
      clientHeight: 900,
      overscanItems: 12,
      resolveItemSize: (_item, index) => 72 + (index % 7) * 18,
    });

    expect(window.start).toBeGreaterThan(0);
    expect(window.end).toBeLessThan(items.length);
    expect(window.end - window.start).toBeLessThanOrEqual(40);
    expect(window.topSpacerPx).toBeGreaterThan(350000);
    expect(window.bottomSpacerPx).toBeGreaterThan(400000);
  });

  it('sizes a retained window from visible rows plus configured fetch-ahead items', () => {
    const count = resolveViewportDrivenWindowCount({
      viewport: { clientHeight: 600 } as HTMLDivElement,
      fetchAheadItems: 30,
      fallbackCount: 80,
      observedSizes: [144, 152, 148, 150],
    });

    expect(count).toBe(64);
  });

  it('computes scroll compensation from size changes above the current browse anchor', () => {
    const delta = resolveScrollCompensationDelta({
      anchorAbsoluteIndex: 25,
      changes: [
        { absoluteIndex: 10, previousSize: 100, nextSize: 132 },
        { absoluteIndex: 18, previousSize: 80, nextSize: 70 },
        { absoluteIndex: 30, previousSize: 90, nextSize: 140 },
      ],
    });

    expect(delta).toBe(22);
  });

  it('shifts an overlapping kernel backward without inventing off-window pixel space', () => {
    const request = resolveKernelWindowRequest({
      items: Array.from({ length: 60 }, (_, index) => index),
      viewportMetrics: { scrollTop: 0, clientHeight: 500, clientWidth: 900 },
      retainedWindow: { windowStart: 200, windowEnd: 260, totalCount: 1000 },
      fetchAheadItems: 20,
      resolveItemSize: () => 100,
      anchorAbsoluteIndex: 200,
    });

    expect(request).toEqual({ startIndex: 174, count: 60 });
    expect(request!.startIndex).toBeLessThanOrEqual(200);
    expect(request!.startIndex + request!.count).toBeGreaterThan(200);
  });

  it('shifts the same bounded kernel forward and eventually reaches the live tail', () => {
    const request = resolveKernelWindowRequest({
      items: Array.from({ length: 60 }, (_, index) => index),
      viewportMetrics: { scrollTop: 5500, clientHeight: 500, clientWidth: 900 },
      retainedWindow: { windowStart: 200, windowEnd: 260, totalCount: 300 },
      fetchAheadItems: 20,
      resolveItemSize: () => 100,
      anchorAbsoluteIndex: 255,
    });

    expect(request).toEqual({ startIndex: 228, count: 60 });

    const tailRequest = resolveKernelWindowRequest({
      items: Array.from({ length: 60 }, (_, index) => index),
      viewportMetrics: { scrollTop: 5500, clientHeight: 500, clientWidth: 900 },
      retainedWindow: { windowStart: 228, windowEnd: 288, totalCount: 300 },
      fetchAheadItems: 20,
      resolveItemSize: () => 100,
      anchorAbsoluteIndex: 283,
    });
    expect(tailRequest).toEqual({ startIndex: 240, count: 60 });
    expect(tailRequest!.startIndex + tailRequest!.count).toBe(300);
  });

  it('does not refetch at a canonical bound when the loaded kernel already covers it', () => {
    expect(
      resolveKernelWindowRequest({
        items: Array.from({ length: 60 }, (_, index) => index),
        viewportMetrics: { scrollTop: 0, clientHeight: 500, clientWidth: 900 },
        retainedWindow: { windowStart: 0, windowEnd: 60, totalCount: 300 },
        fetchAheadItems: 20,
        resolveItemSize: () => 100,
      }),
    ).toBeNull();
  });
});
