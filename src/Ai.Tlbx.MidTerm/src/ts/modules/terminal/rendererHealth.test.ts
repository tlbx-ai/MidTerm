import { describe, expect, it } from 'vitest';

import {
  classifyTerminalRendererPixels,
  getStalledRendererRecoveryAction,
} from './rendererHealth';

function pixels(colors: Array<[number, number, number, number]>): Uint8ClampedArray {
  return new Uint8ClampedArray(colors.flat());
}

describe('terminal renderer health', () => {
  it('does not diagnose an intentionally empty terminal', () => {
    expect(
      classifyTerminalRendererPixels(
        pixels(Array.from({ length: 20 }, () => [0, 0, 0, 255])),
        4,
      ),
    ).toBe('indeterminate');
  });

  it('diagnoses a uniform framebuffer when the visible buffer contains text', () => {
    expect(
      classifyTerminalRendererPixels(
        pixels(Array.from({ length: 100 }, () => [16, 16, 16, 255])),
        200,
      ),
    ).toBe('stalled');
  });

  it('accepts visible text pixels that differ from the dominant background', () => {
    const colors: Array<[number, number, number, number]> = Array.from(
      { length: 90 },
      () => [16, 16, 16, 255],
    );
    colors.push(...Array.from({ length: 10 }, () => [240, 240, 240, 255] as const));

    expect(classifyTerminalRendererPixels(pixels(colors), 100)).toBe('healthy');
  });

  it('escalates from repaint through WebGL quarantine to canonical replay', () => {
    expect(getStalledRendererRecoveryAction(1)).toBe('refresh');
    expect(getStalledRendererRecoveryAction(2)).toBe('quarantine-webgl');
    expect(getStalledRendererRecoveryAction(3)).toBe('replay');
    expect(getStalledRendererRecoveryAction(9)).toBe('replay');
  });
});
