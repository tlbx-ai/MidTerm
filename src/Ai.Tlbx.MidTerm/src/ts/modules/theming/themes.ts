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
import { shouldRenderBackgroundImage } from './backgroundVisibility';
import { getTerminalThemeByName } from './terminalColorSchemes';

const ANSI_COLOR_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const satisfies readonly (keyof TerminalTheme)[];

const DOM_ANSI_OVERRIDE_STYLE_ID = 'midterm-xterm-ansi-overrides';

type ResolvedTerminalTheme = {
  baseTheme: TerminalTheme;
  theme: TerminalTheme;
  terminalBackgroundAlpha: number;
  cellBackgroundAlpha: number;
};

export function getEffectiveTerminalBackgroundAlpha(
  settings: MidTermSettingsPublic | null,
): number {
  return transparencyToAlpha(settings?.terminalTransparency ?? settings?.uiTransparency ?? 0);
}

export function getEffectiveTerminalCellBackgroundAlpha(
  settings: MidTermSettingsPublic | null,
): number {
  return transparencyToAlpha(
    settings?.terminalCellBackgroundTransparency ??
      settings?.terminalTransparency ??
      settings?.uiTransparency ??
      0,
  );
}

/**
 * Resolve the effective xterm color scheme.
 * If terminalColorScheme is 'auto', falls back to the UI theme.
 */
export function getEffectiveXtermTheme(): TerminalTheme {
  const settings = $currentSettings.get();
  syncEffectiveXtermThemeDomOverrides(settings);
  return getEffectiveXtermThemeForSettings(settings);
}

export function getEffectiveXtermThemeForSettings(
  settings: MidTermSettingsPublic | null,
): TerminalTheme {
  return resolveEffectiveXtermTheme(settings).theme;
}

export function syncEffectiveXtermThemeDomOverrides(settings: MidTermSettingsPublic | null): void {
  if (typeof document === 'undefined') {
    return;
  }

  const existing = document.getElementById(DOM_ANSI_OVERRIDE_STYLE_ID);
  const { baseTheme, theme, cellBackgroundAlpha } = resolveEffectiveXtermTheme(settings);
  if (cellBackgroundAlpha >= 1) {
    existing?.remove();
    return;
  }

  const style = existing instanceof HTMLStyleElement ? existing : document.createElement('style');
  style.id = DOM_ANSI_OVERRIDE_STYLE_ID;
  style.textContent = buildDomAnsiOverrideCss(baseTheme, theme);

  const parent = document.body;
  if (style.parentElement !== parent) {
    style.remove();
    parent.appendChild(style);
    return;
  }

  parent.appendChild(style);
}

function resolveEffectiveXtermTheme(settings: MidTermSettingsPublic | null): ResolvedTerminalTheme {
  const colorScheme = settings?.terminalColorScheme ?? 'auto';
  const key = colorScheme === 'auto' ? (settings?.theme ?? 'dark') : colorScheme;
  const fallbackTheme = THEMES['dark'];
  if (!fallbackTheme) {
    throw new Error("Theme 'dark' not found");
  }
  const baseTheme = getTerminalThemeByName(settings, key) ?? fallbackTheme;
  const theme: TerminalTheme = Object.assign({}, baseTheme);
  const terminalBackgroundAlpha = getEffectiveTerminalBackgroundAlpha(settings);
  const cellBackgroundAlpha = getEffectiveTerminalCellBackgroundAlpha(settings);
  const hasWallpaper = shouldRenderBackgroundImage(settings);

  if (hasWallpaper || terminalBackgroundAlpha < 1) {
    theme.background = withAlpha(theme.background, terminalBackgroundAlpha);
  }

  if (hasWallpaper || cellBackgroundAlpha < 1) {
    applyAnsiTransparency(theme, cellBackgroundAlpha);
  }

  return { baseTheme, theme, terminalBackgroundAlpha, cellBackgroundAlpha };
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

function applyAnsiTransparency(theme: TerminalTheme, alpha: number): void {
  for (const key of ANSI_COLOR_KEYS) {
    const color = theme[key];
    if (typeof color === 'string' && color.length > 0) {
      theme[key] = withAlpha(color, alpha);
    }
  }
}

function buildDomAnsiOverrideCss(baseTheme: TerminalTheme, effectiveTheme: TerminalTheme): string {
  return ANSI_COLOR_KEYS.map((key, index) => {
    const opaque = baseTheme[key];
    const transparent = effectiveTheme[key];
    if (typeof opaque !== 'string' || typeof transparent !== 'string') {
      return '';
    }

    return [
      `.xterm .xterm-fg-${String(index)} { color: ${opaque}; }`,
      `.xterm .xterm-fg-${String(index)}.xterm-dim { color: ${withAlpha(opaque, 0.5)}; }`,
      `.xterm .xterm-bg-${String(index)} { background-color: ${transparent}; }`,
    ].join('\n');
  }).join('\n');
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

function transparencyToAlpha(transparency: number): number {
  const clampedTransparency = Math.min(Math.max(transparency, 0), 100);
  return Math.max(0, 1 - clampedTransparency / 100);
}
