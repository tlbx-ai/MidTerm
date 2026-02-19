/**
 * Theming Module
 *
 * Theme definitions and application to xterm.js terminals.
 */

import type { ThemeName, TerminalTheme } from '../../types';
import { THEMES } from '../../constants';
import { sessionTerminals } from '../../state';
import { $currentSettings } from '../../stores';
import { setCookie } from '../../utils';
import { applyCssTheme } from './cssThemes';

/**
 * Resolve the effective xterm color scheme.
 * If terminalColorScheme is 'auto', falls back to the UI theme.
 */
export function getEffectiveXtermTheme(): TerminalTheme {
  const s = $currentSettings.get();
  const colorScheme = s?.terminalColorScheme ?? 'auto';
  const key = colorScheme === 'auto' ? (s?.theme ?? 'dark') : colorScheme;
  return THEMES[key] ?? THEMES['dark']!;
}

/**
 * Get the current theme based on settings
 */
export function getCurrentTheme(): TerminalTheme {
  return getEffectiveXtermTheme();
}

/**
 * Apply the effective xterm theme to all terminals
 */
export function applyXtermThemeToTerminals(): void {
  const theme = getEffectiveXtermTheme();
  sessionTerminals.forEach((state) => {
    state.terminal.options.theme = theme;
  });
}

/**
 * Apply theme and persist to cookie
 */
export function setTheme(themeName: ThemeName): void {
  setCookie('mm-theme', themeName);
  applyXtermThemeToTerminals();
  applyCssTheme(themeName);
}

/**
 * Initialize theme from saved cookie
 */
export function initThemeFromCookie(): void {
  const savedTheme = document.cookie.match(/mm-theme=([^;]+)/)?.[1] as ThemeName | undefined;
  if (savedTheme && THEMES[savedTheme]) {
    applyCssTheme(savedTheme);
  }
}
