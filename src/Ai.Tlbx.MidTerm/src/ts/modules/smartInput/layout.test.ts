import { describe, expect, it } from 'vitest';

import { calculateAdaptiveFooterReservedHeight, getAdaptiveFooterRailSequence } from './layout';

describe('smart input adaptive footer layout helpers', () => {
  it('keeps mobile AppServerControl status awareness ahead of the composer while terminal mobile keeps status after primary', () => {
    expect(getAdaptiveFooterRailSequence({ appServerControlActive: true, isMobile: true })).toEqual(
      ['status', 'primary', 'context', 'automation'],
    );
    expect(
      getAdaptiveFooterRailSequence({ appServerControlActive: false, isMobile: true }),
    ).toEqual(['primary', 'status', 'context', 'automation']);
    expect(
      getAdaptiveFooterRailSequence({ appServerControlActive: true, isMobile: false }),
    ).toEqual(['primary', 'context', 'automation', 'status']);
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
