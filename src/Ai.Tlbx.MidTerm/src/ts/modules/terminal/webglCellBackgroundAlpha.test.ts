import { describe, expect, it } from 'vitest';

import type { MidTermSettingsPublic } from '../../api/types';
import {
  getWebglTerminalCellBackgroundAlpha,
  getWindowWebglTerminalCellBackgroundAlpha,
} from './webglCellBackgroundAlpha';

function createSettings(
  partial: Partial<
    Pick<
      MidTermSettingsPublic,
      'terminalTransparency' | 'terminalCellBackgroundTransparency' | 'uiTransparency'
    >
  >,
): MidTermSettingsPublic {
  return {
    terminalTransparency: 0,
    terminalCellBackgroundTransparency: 0,
    uiTransparency: 0,
    ...partial,
  } as MidTermSettingsPublic;
}

describe('webglCellBackgroundAlpha', () => {
  it('maps Terminal Cell Background Transparency to a normalized alpha', () => {
    expect(
      getWebglTerminalCellBackgroundAlpha(
        createSettings({
          terminalCellBackgroundTransparency: 60,
        }),
      ),
    ).toBe(0.4);
  });

  it('falls back to an opaque alpha when the window global is unavailable', () => {
    expect(getWindowWebglTerminalCellBackgroundAlpha(undefined)).toBe(1);
  });

  it('clamps the window global alpha into the valid range', () => {
    expect(
      getWindowWebglTerminalCellBackgroundAlpha({
        __MIDTERM_XTERM_WEBGL_CELL_BG_ALPHA__: 1.5,
      } as Window),
    ).toBe(1);
    expect(
      getWindowWebglTerminalCellBackgroundAlpha({
        __MIDTERM_XTERM_WEBGL_CELL_BG_ALPHA__: -0.25,
      } as Window),
    ).toBe(0);
  });
});
