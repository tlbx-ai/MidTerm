import { describe, expect, it } from 'vitest';

import { classifyTerminalStartupPixels, getTerminalStartupPaintAction } from './startupPaintHealth';

function pixels(colors: Array<[number, number, number, number]>): Uint8ClampedArray {
  return new Uint8ClampedArray(colors.flat());
}

describe('terminal startup paint health', () => {
  it('does not diagnose an intentionally empty terminal', () => {
    expect(
      classifyTerminalStartupPixels(pixels(Array.from({ length: 20 }, () => [0, 0, 0, 255])), 4),
    ).toBe('indeterminate');
  });

  it('detects a uniform framebuffer when the visible buffer contains text', () => {
    expect(
      classifyTerminalStartupPixels(
        pixels(Array.from({ length: 100 }, () => [16, 16, 16, 255])),
        200,
      ),
    ).toBe('blank');
  });

  it('accepts visible text pixels that differ from the dominant background', () => {
    const colors: Array<[number, number, number, number]> = Array.from({ length: 90 }, () => [
      16, 16, 16, 255,
    ]);
    colors.push(...Array.from({ length: 10 }, () => [240, 240, 240, 255] as const));

    expect(classifyTerminalStartupPixels(pixels(colors), 100)).toBe('healthy');
  });

  it('bounds retries and escalates only confirmed consecutive blank paints', () => {
    expect(getTerminalStartupPaintAction('indeterminate', 0, 1, 6)).toBe('retry');
    expect(getTerminalStartupPaintAction('indeterminate', 0, 6, 6)).toBe('complete');
    expect(getTerminalStartupPaintAction('blank', 1, 1, 6)).toBe('refresh');
    expect(getTerminalStartupPaintAction('blank', 2, 2, 6)).toBe('fallback');
    expect(getTerminalStartupPaintAction('healthy', 4, 4, 6)).toBe('complete');
  });
});
