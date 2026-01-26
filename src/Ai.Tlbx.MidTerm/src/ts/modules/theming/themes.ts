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

/**
 * Get the current theme based on settings
 */
export function getCurrentTheme(): TerminalTheme {
  const themeName = $currentSettings.get()?.theme || 'dark';
  return THEMES[themeName] || THEMES.dark;
}

/**
 * Apply theme to all terminals
 */
export function applyThemeToTerminals(themeName: ThemeName): void {
  const theme = THEMES[themeName];
  if (!theme) return;

  sessionTerminals.forEach((state) => {
    state.terminal.options.theme = theme;
  });
}

/**
 * Apply theme and persist to cookie
 */
export function setTheme(themeName: ThemeName): void {
  setCookie('mm-theme', themeName);
  applyThemeToTerminals(themeName);

  // Update CSS variable for flash prevention
  document.documentElement.style.setProperty('--terminal-bg', THEMES[themeName].background);
}

/**
 * Initialize theme from saved cookie
 */
export function initThemeFromCookie(): void {
  const savedTheme = document.cookie.match(/mm-theme=([^;]+)/)?.[1] as ThemeName | undefined;
  if (savedTheme && THEMES[savedTheme]) {
    document.documentElement.style.setProperty('--terminal-bg', THEMES[savedTheme].background);
  }
}
