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
    terminalColorSchemes: [],
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

    expect(theme.background).toBe('rgba(12, 12, 12, 0.400)');
  });

  it('applies terminal transparency to ANSI background palette colors', () => {
    const theme = getEffectiveXtermThemeForSettings(
      createSettings({
        terminalTransparency: 60,
      }),
    );

    expect(theme.red).toBe('rgba(255, 64, 85, 0.400)');
    expect(theme.brightBlue).toBe('rgba(125, 166, 255, 0.400)');
  });

  it('allows the terminal transparency slider to reach a fully transparent xterm background', () => {
    const theme = getEffectiveXtermThemeForSettings(
      createSettings({
        terminalTransparency: 100,
      }),
    );

    expect(theme.background).toBe('rgba(12, 12, 12, 0.000)');
  });

  it('falls back to ui transparency when terminal transparency is absent', () => {
    const theme = getEffectiveXtermThemeForSettings(
      createSettings({
        uiTransparency: 35,
        terminalTransparency: null,
      }),
    );

    expect(theme.background).toBe('rgba(12, 12, 12, 0.650)');
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

  it('resolves the campbell palette', () => {
    const theme = getEffectiveXtermThemeForSettings(
      createSettings({
        terminalColorScheme: 'campbell',
      }),
    );

    expect(theme.background).toBe('#0C0C0C');
    expect(theme.foreground).toBe('#CCCCCC');
    expect(theme.blue).toBe('#0037DA');
    expect(theme.brightCyan).toBe('#61D6D6');
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

  it('resolves a saved custom palette by name', () => {
    const theme = getEffectiveXtermThemeForSettings(
      createSettings({
        terminalColorScheme: 'Ocean Copy',
        terminalColorSchemes: [
          {
            name: 'Ocean Copy',
            background: '#101820',
            foreground: '#F2F7FF',
            cursor: '#F2F7FF',
            cursorAccent: '#101820',
            selectionBackground: '#2A4C66',
            scrollbarSliderBackground: 'rgba(242, 247, 255, 0.2)',
            scrollbarSliderHoverBackground: 'rgba(242, 247, 255, 0.35)',
            scrollbarSliderActiveBackground: 'rgba(242, 247, 255, 0.5)',
            black: '#18242E',
            red: '#FF6B6B',
            green: '#7EE787',
            yellow: '#F9E27D',
            blue: '#66B3FF',
            magenta: '#D2A8FF',
            cyan: '#7DE3FF',
            white: '#D8E7F5',
            brightBlack: '#5A7288',
            brightRed: '#FF8E8E',
            brightGreen: '#9CF0A4',
            brightYellow: '#FFEEA8',
            brightBlue: '#90CCFF',
            brightMagenta: '#E2C0FF',
            brightCyan: '#A1EEFF',
            brightWhite: '#F2F7FF',
          },
        ],
      }),
    );

    expect(theme.background).toBe('#101820');
    expect(theme.foreground).toBe('#F2F7FF');
    expect(theme.blue).toBe('#66B3FF');
    expect(theme.brightCyan).toBe('#A1EEFF');
  });

  it('applies transparency to custom ANSI palette colors too', () => {
    const theme = getEffectiveXtermThemeForSettings(
      createSettings({
        terminalTransparency: 25,
        terminalColorScheme: 'Ocean Copy',
        terminalColorSchemes: [
          {
            name: 'Ocean Copy',
            background: '#101820',
            foreground: '#F2F7FF',
            cursor: '#F2F7FF',
            cursorAccent: '#101820',
            selectionBackground: '#2A4C66',
            scrollbarSliderBackground: 'rgba(242, 247, 255, 0.2)',
            scrollbarSliderHoverBackground: 'rgba(242, 247, 255, 0.35)',
            scrollbarSliderActiveBackground: 'rgba(242, 247, 255, 0.5)',
            black: '#18242E',
            red: '#FF6B6B',
            green: '#7EE787',
            yellow: '#F9E27D',
            blue: '#66B3FF',
            magenta: '#D2A8FF',
            cyan: '#7DE3FF',
            white: '#D8E7F5',
            brightBlack: '#5A7288',
            brightRed: '#FF8E8E',
            brightGreen: '#9CF0A4',
            brightYellow: '#FFEEA8',
            brightBlue: '#90CCFF',
            brightMagenta: '#E2C0FF',
            brightCyan: '#A1EEFF',
            brightWhite: '#F2F7FF',
          },
        ],
      }),
    );

    expect(theme.background).toBe('rgba(16, 24, 32, 0.750)');
    expect(theme.blue).toBe('rgba(102, 179, 255, 0.750)');
    expect(theme.brightWhite).toBe('rgba(242, 247, 255, 0.750)');
  });
});
