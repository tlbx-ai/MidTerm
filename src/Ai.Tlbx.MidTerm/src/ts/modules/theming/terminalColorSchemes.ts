import type { MidTermSettingsPublic, TerminalColorSchemeDefinition } from '../../api/types';
import type { TerminalTheme } from '../../types';
import { THEMES } from '../../constants';

export const BUILT_IN_TERMINAL_COLOR_SCHEME_OPTIONS = [
  {
    value: 'dark',
    translationKey: 'settings.options.themeDark',
    fallbackText: 'Dark',
  },
  {
    value: 'light',
    translationKey: 'settings.options.themeLight',
    fallbackText: 'Light',
  },
  {
    value: 'macTerminalDark',
    translationKey: 'settings.options.colorSchemeMacTerminalDark',
    fallbackText: 'Mac Terminal Dark',
  },
  {
    value: 'macTerminalLight',
    translationKey: 'settings.options.colorSchemeMacTerminalLight',
    fallbackText: 'Mac Terminal Light',
  },
  {
    value: 'solarizedDark',
    translationKey: 'settings.options.themeSolarizedDark',
    fallbackText: 'Solarized Dark',
  },
  {
    value: 'solarizedLight',
    translationKey: 'settings.options.themeSolarizedLight',
    fallbackText: 'Solarized Light',
  },
  {
    value: 'matrix',
    translationKey: 'settings.options.colorSchemeMatrix',
    fallbackText: 'Matrix',
  },
] as const;

export const BUILT_IN_TERMINAL_COLOR_SCHEME_NAMES = new Set<string>([
  'auto',
  ...BUILT_IN_TERMINAL_COLOR_SCHEME_OPTIONS.map((option) => option.value),
]);

export const TERMINAL_COLOR_SCHEME_FIELDS = [
  { key: 'background', label: 'Background', group: 'Core', input: 'color' },
  { key: 'foreground', label: 'Foreground', group: 'Core', input: 'color' },
  { key: 'cursor', label: 'Cursor', group: 'Core', input: 'color' },
  { key: 'cursorAccent', label: 'Cursor Accent', group: 'Core', input: 'color' },
  { key: 'selectionBackground', label: 'Selection', group: 'Core', input: 'color' },
  { key: 'black', label: 'Black', group: 'Standard ANSI', input: 'color' },
  { key: 'red', label: 'Red', group: 'Standard ANSI', input: 'color' },
  { key: 'green', label: 'Green', group: 'Standard ANSI', input: 'color' },
  { key: 'yellow', label: 'Yellow', group: 'Standard ANSI', input: 'color' },
  { key: 'blue', label: 'Blue', group: 'Standard ANSI', input: 'color' },
  { key: 'magenta', label: 'Magenta', group: 'Standard ANSI', input: 'color' },
  { key: 'cyan', label: 'Cyan', group: 'Standard ANSI', input: 'color' },
  { key: 'white', label: 'White', group: 'Standard ANSI', input: 'color' },
  { key: 'brightBlack', label: 'Bright Black', group: 'Bright ANSI', input: 'color' },
  { key: 'brightRed', label: 'Bright Red', group: 'Bright ANSI', input: 'color' },
  { key: 'brightGreen', label: 'Bright Green', group: 'Bright ANSI', input: 'color' },
  { key: 'brightYellow', label: 'Bright Yellow', group: 'Bright ANSI', input: 'color' },
  { key: 'brightBlue', label: 'Bright Blue', group: 'Bright ANSI', input: 'color' },
  { key: 'brightMagenta', label: 'Bright Magenta', group: 'Bright ANSI', input: 'color' },
  { key: 'brightCyan', label: 'Bright Cyan', group: 'Bright ANSI', input: 'color' },
  { key: 'brightWhite', label: 'Bright White', group: 'Bright ANSI', input: 'color' },
  {
    key: 'scrollbarSliderBackground',
    label: 'Scrollbar',
    group: 'Advanced',
    input: 'text',
  },
  {
    key: 'scrollbarSliderHoverBackground',
    label: 'Scrollbar Hover',
    group: 'Advanced',
    input: 'text',
  },
  {
    key: 'scrollbarSliderActiveBackground',
    label: 'Scrollbar Active',
    group: 'Advanced',
    input: 'text',
  },
] as const;

export type TerminalColorSchemeFieldKey = (typeof TERMINAL_COLOR_SCHEME_FIELDS)[number]['key'];

export function isBuiltInTerminalColorSchemeName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') {
    return false;
  }

  const normalizedName = name.trim().toLowerCase();
  return Array.from(BUILT_IN_TERMINAL_COLOR_SCHEME_NAMES).some(
    (entry) => entry.toLowerCase() === normalizedName,
  );
}

export function getBuiltInTerminalTheme(name: string): TerminalTheme | null {
  const theme = THEMES[name];
  return theme ? cloneTerminalTheme(theme) : null;
}

export function findCustomTerminalColorScheme(
  settings: MidTermSettingsPublic | null | undefined,
  name: string,
): TerminalColorSchemeDefinition | null {
  const normalizedName = name.trim();
  if (!normalizedName) {
    return null;
  }

  return (
    settings?.terminalColorSchemes.find(
      (scheme) => scheme.name.trim().toLowerCase() === normalizedName.toLowerCase(),
    ) ?? null
  );
}

export function getTerminalThemeByName(
  settings: MidTermSettingsPublic | null | undefined,
  name: string,
): TerminalTheme | null {
  const builtInTheme = getBuiltInTerminalTheme(name);
  if (builtInTheme) {
    return builtInTheme;
  }

  const customScheme = findCustomTerminalColorScheme(settings, name);
  return customScheme ? terminalColorSchemeToTheme(customScheme) : null;
}

export function terminalColorSchemeToTheme(
  definition: TerminalColorSchemeDefinition,
): TerminalTheme {
  return {
    background: definition.background,
    foreground: definition.foreground,
    cursor: definition.cursor,
    cursorAccent: definition.cursorAccent,
    selectionBackground: definition.selectionBackground,
    scrollbarSliderBackground: definition.scrollbarSliderBackground,
    scrollbarSliderHoverBackground: definition.scrollbarSliderHoverBackground,
    scrollbarSliderActiveBackground: definition.scrollbarSliderActiveBackground,
    black: definition.black,
    red: definition.red,
    green: definition.green,
    yellow: definition.yellow,
    blue: definition.blue,
    magenta: definition.magenta,
    cyan: definition.cyan,
    white: definition.white,
    brightBlack: definition.brightBlack,
    brightRed: definition.brightRed,
    brightGreen: definition.brightGreen,
    brightYellow: definition.brightYellow,
    brightBlue: definition.brightBlue,
    brightMagenta: definition.brightMagenta,
    brightCyan: definition.brightCyan,
    brightWhite: definition.brightWhite,
  };
}

export function themeToTerminalColorSchemeDefinition(
  name: string,
  theme: TerminalTheme,
): TerminalColorSchemeDefinition {
  return {
    name,
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    cursorAccent: theme.cursorAccent,
    selectionBackground: theme.selectionBackground,
    scrollbarSliderBackground: theme.scrollbarSliderBackground,
    scrollbarSliderHoverBackground: theme.scrollbarSliderHoverBackground,
    scrollbarSliderActiveBackground: theme.scrollbarSliderActiveBackground,
    black: theme.black ?? '#000000',
    red: theme.red ?? '#FF0000',
    green: theme.green ?? '#00FF00',
    yellow: theme.yellow ?? '#FFFF00',
    blue: theme.blue ?? '#0000FF',
    magenta: theme.magenta ?? '#FF00FF',
    cyan: theme.cyan ?? '#00FFFF',
    white: theme.white ?? '#FFFFFF',
    brightBlack: theme.brightBlack ?? theme.black ?? '#808080',
    brightRed: theme.brightRed ?? theme.red ?? '#FF0000',
    brightGreen: theme.brightGreen ?? theme.green ?? '#00FF00',
    brightYellow: theme.brightYellow ?? theme.yellow ?? '#FFFF00',
    brightBlue: theme.brightBlue ?? theme.blue ?? '#0000FF',
    brightMagenta: theme.brightMagenta ?? theme.magenta ?? '#FF00FF',
    brightCyan: theme.brightCyan ?? theme.cyan ?? '#00FFFF',
    brightWhite: theme.brightWhite ?? theme.white ?? '#FFFFFF',
  };
}

export function cloneTerminalTheme(theme: TerminalTheme): TerminalTheme {
  return { ...theme };
}

export function suggestCustomTerminalColorSchemeName(
  baseName: string,
  settings: MidTermSettingsPublic | null | undefined,
): string {
  const trimmedBaseName = baseName.trim() || 'Custom Scheme';
  const existingNames = new Set(
    (settings?.terminalColorSchemes ?? []).map((scheme) => scheme.name.trim().toLowerCase()),
  );

  let attempt = `${trimmedBaseName} Copy`;
  let suffix = 2;
  while (isBuiltInTerminalColorSchemeName(attempt) || existingNames.has(attempt.toLowerCase())) {
    attempt = `${trimmedBaseName} Copy ${String(suffix)}`;
    suffix++;
  }

  return attempt;
}
