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

  it('allows the terminal transparency slider to reach a fully transparent xterm background', () => {
    const theme = getEffectiveXtermThemeForSettings(
      createSettings({
        terminalTransparency: 100,
      }),
    );

    expect(theme.background).toBe('rgba(5, 5, 10, 0.000)');
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

  it('resolves the mac terminal dark palette', () => {
    const theme = getEffectiveXtermThemeForSettings(
      createSettings({
        terminalColorScheme: 'macTerminalDark',
      }),
    );

    expect(theme.background).toBe('#000000');
    expect(theme.foreground).toBe('#FFFFFF');
    expect(theme.blue).toBe('#6444ED');
    expect(theme.brightBlue).toBe('#D09AF9');
  });

  it('resolves the mac terminal light palette', () => {
    const theme = getEffectiveXtermThemeForSettings(
      createSettings({
        terminalColorScheme: 'macTerminalLight',
      }),
    );

    expect(theme.background).toBe('#FFFFFF');
    expect(theme.foreground).toBe('#000000');
    expect(theme.blue).toBe('#0000B2');
    expect(theme.brightBlue).toBe('#0000FF');
  });
});
