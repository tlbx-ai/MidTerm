/**
 * Theming Module
 *
 * Theme definitions and application to xterm.js terminals.
 */

import type { MidTermSettingsPublic, ThemeName, TerminalTheme } from '../../types';
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
  return getEffectiveXtermThemeForSettings($currentSettings.get());
}

export function getEffectiveXtermThemeForSettings(
  settings: MidTermSettingsPublic | null,
): TerminalTheme {
  const colorScheme = settings?.terminalColorScheme ?? 'auto';
  const key = colorScheme === 'auto' ? (settings?.theme ?? 'dark') : colorScheme;
  const fallbackTheme = THEMES['dark'];
  if (!fallbackTheme) {
    throw new Error("Theme 'dark' not found");
  }
  const baseTheme = THEMES[key] ?? fallbackTheme;
  const theme: TerminalTheme = Object.assign({}, baseTheme);
  const transparency = Math.min(
    Math.max(settings?.terminalTransparency ?? settings?.uiTransparency ?? 0, 0),
    100,
  );
  const hasWallpaper =
    settings !== null &&
    settings.backgroundImageEnabled &&
    settings.backgroundImageFileName !== null;
  if (hasWallpaper || transparency > 0) {
    const alpha = Math.max(0, 1 - transparency / 100);
    theme.background = withAlpha(theme.background, alpha);
  }
  return theme;
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

function withAlpha(color: string, alpha: number): string {
  const trimmed = color.trim();
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    const normalized =
      hex.length === 3
        ? hex
            .split('')
            .map((part) => part + part)
            .join('')
        : hex.slice(0, 6);

    if (normalized.length === 6) {
      const r = Number.parseInt(normalized.slice(0, 2), 16);
      const g = Number.parseInt(normalized.slice(2, 4), 16);
      const b = Number.parseInt(normalized.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
    }
  }

  const rgbMatch = trimmed.match(/rgba?\(([^)]+)\)/i);
  if (rgbMatch) {
    const parts = rgbMatch[1]?.split(',').map((part) => Number.parseFloat(part.trim()));
    if (parts && parts.length >= 3) {
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha.toFixed(3)})`;
    }
  }

  return color;
}
