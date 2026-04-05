import { describe, expect, it } from 'vitest';

import {
  calculateAdaptiveFooterReservedHeight,
  getAdaptiveFooterRailSequence,
} from './layout';

describe('smart input adaptive footer layout helpers', () => {
  it('places automation ahead of context only for mobile Lens sessions', () => {
    expect(getAdaptiveFooterRailSequence({ lensActive: true, isMobile: true })).toEqual([
      'primary',
      'automation',
      'context',
      'status',
    ]);
    expect(getAdaptiveFooterRailSequence({ lensActive: false, isMobile: true })).toEqual([
      'primary',
      'context',
      'automation',
      'status',
    ]);
    expect(getAdaptiveFooterRailSequence({ lensActive: true, isMobile: false })).toEqual([
      'primary',
      'context',
      'automation',
      'status',
    ]);
  });

  it('keeps multiline textarea growth out of the reserved pane height', () => {
    expect(
      calculateAdaptiveFooterReservedHeight({
        dockHeight: 160,
        textareaHeight: 96,
        collapsedTextareaHeight: 48,
      }),
    ).toBe(112);
  });

  it('never produces a negative reserve height', () => {
    expect(
      calculateAdaptiveFooterReservedHeight({
        dockHeight: 40,
        textareaHeight: 120,
        collapsedTextareaHeight: 48,
      }),
    ).toBe(0);
  });
});
