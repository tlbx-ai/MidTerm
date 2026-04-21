import { describe, expect, it } from 'vitest';

import {
  computeVirtualWindow,
  resolveRetainedWindowViewportMetrics,
  resolveScrollCompensationDelta,
  resolveViewportCenteredWindowRequest,
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

  it('sizes a retained window from visible rows plus configured fetch-ahead items', () => {
    const count = resolveViewportDrivenWindowCount({
      viewport: { clientHeight: 600 } as HTMLDivElement,
      fetchAheadItems: 30,
      fallbackCount: 80,
      observedSizes: [144, 152, 148, 150],
    });

    expect(count).toBe(64);
  });

  it('recenters the retained window around the visible range when the viewport nears an edge', () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ id: `row-${index}` }));

    const request = resolveViewportCenteredWindowRequest({
      items,
      viewportMetrics: {
        scrollTop: 1500,
        clientHeight: 300,
        clientWidth: 900,
      },
      retainedWindow: {
        windowStart: 0,
        windowEnd: 20,
        totalCount: 60,
      },
      fetchAheadItems: 5,
      resolveItemSize: () => 100,
    });

    expect(request).toEqual({
      startIndex: 10,
      count: 13,
    });
  });

  it('stabilizes unseen spacer estimates around the global observed representative', () => {
    const metrics = resolveRetainedWindowViewportMetrics({
      items: Array.from({ length: 10 }, (_, index) => ({ id: `row-${index}` })),
      viewportMetrics: {
        scrollTop: 0,
        clientHeight: 600,
        clientWidth: 900,
      },
      retainedWindow: {
        windowStart: 50,
        windowEnd: 60,
        totalCount: 100,
      },
      observedSizes: [100, 102, 98, 101, 99],
      resolveItemSize: () => 220,
      resolveEstimatedItemSize: () => 210,
    });

    expect(metrics.offWindowTopSpacerPx).toBe(6000);
    expect(metrics.effectiveOffWindowTopSpacerPx).toBe(0);
    expect(metrics.offWindowBottomSpacerPx).toBe(4800);
  });

  it('caps the viewport-aligned off-window top spacer so visible rows remain reachable', () => {
    const metrics = resolveRetainedWindowViewportMetrics({
      items: Array.from({ length: 10 }, (_, index) => ({ id: `row-${index}` })),
      viewportMetrics: {
        scrollTop: 240,
        clientHeight: 600,
        clientWidth: 900,
      },
      retainedWindow: {
        windowStart: 50,
        windowEnd: 60,
        totalCount: 100,
      },
      observedSizes: [100, 102, 98, 101, 99],
      resolveItemSize: () => 220,
      resolveEstimatedItemSize: () => 210,
    });

    expect(metrics.offWindowTopSpacerPx).toBe(6000);
    expect(metrics.effectiveOffWindowTopSpacerPx).toBe(240);
    expect(metrics.scrollTop).toBe(0);
  });

  it('targets the absolute viewport position when the reader is still inside unseen older-history space', () => {
    const request = resolveViewportCenteredWindowRequest({
      items: Array.from({ length: 10 }, (_, index) => ({ id: `row-${index}` })),
      viewportMetrics: {
        scrollTop: 240,
        clientHeight: 600,
        clientWidth: 900,
      },
      retainedWindow: {
        windowStart: 50,
        windowEnd: 60,
        totalCount: 100,
      },
      fetchAheadItems: 5,
      observedSizes: [100, 102, 98, 101, 99],
      resolveItemSize: () => 220,
      resolveEstimatedItemSize: () => 210,
    });

    expect(request).toEqual({
      startIndex: 0,
      count: 12,
    });
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
});
