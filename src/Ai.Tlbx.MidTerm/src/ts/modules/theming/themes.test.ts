import { describe, expect, it } from 'vitest';

import type { MidTermSettingsPublic } from '../../api/types';
import { getEffectiveXtermThemeForSettings } from './themes';

function createSettings(
  partial: Partial<
    Pick<
      MidTermSettingsPublic,
      | 'theme'
      | 'terminalColorScheme'
      | 'uiTransparency'
      | 'terminalTransparency'
      | 'backgroundImageEnabled'
      | 'backgroundImageFileName'
    >
  >,
): MidTermSettingsPublic {
  return {
    theme: 'dark',
    terminalColorScheme: 'auto',
    uiTransparency: 0,
    terminalTransparency: 0,
    backgroundImageEnabled: false,
    backgroundImageFileName: null,
    ...partial,
  } as MidTermSettingsPublic;
}

describe('themes', () => {
  it('uses terminal transparency for the xterm background alpha', () => {
    const theme = getEffectiveXtermThemeForSettings(
      createSettings({
        uiTransparency: 10,
        terminalTransparency: 60,
      }),
    );

    expect(theme.background).toBe('rgba(5, 5, 10, 0.400)');
  });

  it('falls back to ui transparency when terminal transparency is absent', () => {
    const theme = getEffectiveXtermThemeForSettings(
      createSettings({
        uiTransparency: 35,
        terminalTransparency: null,
      }),
    );

    expect(theme.background).toBe('rgba(5, 5, 10, 0.650)');
  });
});
