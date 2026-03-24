import { describe, expect, it } from 'vitest';

import type { MidTermSettingsPublic } from '../../api/types';
import { shouldUseWebglRenderer } from './webglSupport';

function createSettings(
  partial: Partial<
    Pick<MidTermSettingsPublic, 'useWebGL'>
  >,
): MidTermSettingsPublic {
  return {
    useWebGL: true,
    ...partial,
  } as MidTermSettingsPublic;
}

describe('webglSupport', () => {
  it('keeps WebGL enabled by default', () => {
    expect(shouldUseWebglRenderer(createSettings({}))).toBe(true);
  });

  it('honors the explicit WebGL toggle', () => {
    expect(shouldUseWebglRenderer(createSettings({ useWebGL: false }))).toBe(false);
  });

  it('ignores transparency and wallpaper settings when WebGL stays enabled', () => {
    expect(
      shouldUseWebglRenderer({
        ...createSettings({}),
        terminalTransparency: 35,
        uiTransparency: 25,
        backgroundImageEnabled: true,
        backgroundImageFileName: 'wallpaper.png',
      } as MidTermSettingsPublic),
    ).toBe(true);
  });
});
