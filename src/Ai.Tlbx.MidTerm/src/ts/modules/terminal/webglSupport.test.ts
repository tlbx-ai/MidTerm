import { describe, expect, it } from 'vitest';

import type { MidTermSettingsPublic } from '../../api/types';
import { shouldUseWebglRenderer } from './webglSupport';

function createSettings(
  partial: Partial<
    Pick<
      MidTermSettingsPublic,
      | 'useWebGL'
      | 'uiTransparency'
      | 'terminalTransparency'
      | 'backgroundImageEnabled'
      | 'backgroundImageFileName'
    >
  >,
): MidTermSettingsPublic {
  return {
    useWebGL: true,
    uiTransparency: 0,
    terminalTransparency: 0,
    backgroundImageEnabled: false,
    backgroundImageFileName: null,
    ...partial,
  } as MidTermSettingsPublic;
}

describe('webglSupport', () => {
  it('keeps WebGL enabled for opaque terminal rendering', () => {
    expect(shouldUseWebglRenderer(createSettings({}))).toBe(true);
  });

  it('disables WebGL when terminal transparency is active', () => {
    expect(shouldUseWebglRenderer(createSettings({ terminalTransparency: 35 }))).toBe(false);
  });

  it('falls back to ui transparency when terminal transparency is unset', () => {
    expect(
      shouldUseWebglRenderer(
        createSettings({
          terminalTransparency: null,
          uiTransparency: 25,
        }),
      ),
    ).toBe(false);
  });

  it('disables WebGL when a wallpaper is active', () => {
    expect(
      shouldUseWebglRenderer(
        createSettings({
          backgroundImageEnabled: true,
          backgroundImageFileName: 'wallpaper.png',
        }),
      ),
    ).toBe(false);
  });

  it('honors the explicit WebGL toggle', () => {
    expect(shouldUseWebglRenderer(createSettings({ useWebGL: false }))).toBe(false);
  });
});
