/**
 * Background Appearance Module
 *
 * Applies wallpaper and pane transparency without fading text content.
 */

import type { MidTermSettingsPublic } from '../../types';
import { getCssThemePalette } from './cssThemes';

const TERMINAL_BACKGROUND_VARIABLES = ['--bg-terminal', '--terminal-bg'] as const;

const UI_BACKGROUND_VARIABLES: Array<{ name: string; boost?: number }> = [
  { name: '--bg-primary', boost: 0.16 },
  { name: '--bg-elevated', boost: 0.22 },
  { name: '--bg-sidebar', boost: 0.22 },
  { name: '--bg-surface', boost: 0.28 },
  { name: '--bg-input', boost: 0.28 },
  { name: '--bg-dropdown', boost: 0.28 },
  { name: '--bg-hover', boost: 0.34 },
  { name: '--bg-active', boost: 0.4 },
  { name: '--bg-session-hover', boost: 0.32 },
  { name: '--bg-session-active', boost: 0.38 },
  { name: '--bg-settings', boost: 0.22 },
  { name: '--bg-tertiary', boost: 0.22 },
];

const OPAQUE_SURFACE_VARIABLES: Array<{ name: string; source: string }> = [
  { name: '--bg-elevated-opaque', source: '--bg-elevated' },
  { name: '--bg-dropdown-opaque', source: '--bg-dropdown' },
];

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export function getBackgroundImageUrl(revision: number): string {
  return `/api/settings/background-image?v=${encodeURIComponent(`${revision}`)}`;
}

export function applyBackgroundAppearance(settings: MidTermSettingsPublic): void {
  const root = document.documentElement;
  const palette = getCssThemePalette(settings.theme);
  const uiTransparency = clamp(settings.uiTransparency, 0, 85);
  const terminalTransparency = clamp(
    settings.terminalTransparency ?? settings.uiTransparency,
    0,
    85,
  );
  const uiBaseAlpha = Math.max(0.15, 1 - uiTransparency / 100);
  const terminalBaseAlpha = Math.max(0.15, 1 - terminalTransparency / 100);

  for (const variable of OPAQUE_SURFACE_VARIABLES) {
    const value = palette[variable.source];
    if (!value) {
      continue;
    }

    root.style.setProperty(variable.name, value);
  }

  for (const variableName of TERMINAL_BACKGROUND_VARIABLES) {
    const value = palette[variableName];
    const rgb = parseColor(value);
    if (!rgb) {
      continue;
    }

    root.style.setProperty(variableName, toRgba(rgb, terminalBaseAlpha));
  }

  for (const variable of UI_BACKGROUND_VARIABLES) {
    const value = palette[variable.name];
    const rgb = parseColor(value);
    if (!rgb) {
      continue;
    }

    const alpha = clamp(uiBaseAlpha + (variable.boost ?? 0), 0, 1);
    root.style.setProperty(variable.name, toRgba(rgb, alpha));
  }

  const hasImage = Boolean(
    settings.backgroundImageEnabled &&
    settings.backgroundImageFileName &&
    settings.backgroundImageRevision > 0,
  );

  root.style.setProperty(
    '--app-background-image',
    hasImage ? `url("${getBackgroundImageUrl(settings.backgroundImageRevision)}")` : 'none',
  );
  root.style.setProperty(
    '--app-background-size',
    settings.backgroundImageFit === 'contain' ? 'contain' : 'cover',
  );
  root.style.setProperty('--app-background-repeat', 'no-repeat');
  root.style.setProperty('--app-background-position', 'center center');
  document.body.classList.toggle('has-app-background', hasImage);
}

function parseColor(value: string | undefined): RgbColor | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (trimmed.startsWith('#')) {
    return parseHexColor(trimmed);
  }

  const rgbMatch = trimmed.match(/rgba?\(([^)]+)\)/i);
  if (!rgbMatch) {
    return null;
  }

  const parts = rgbMatch[1]?.split(',').map((part) => Number.parseFloat(part.trim()));
  if (!parts || parts.length < 3) {
    return null;
  }

  const r = parts[0];
  const g = parts[1];
  const b = parts[2];
  if (
    r === undefined ||
    g === undefined ||
    b === undefined ||
    ![r, g, b].every((part) => Number.isFinite(part))
  ) {
    return null;
  }

  return { r, g, b };
}

function parseHexColor(value: string): RgbColor | null {
  const hex = value.slice(1);
  if (hex.length === 3) {
    const [r, g, b] = hex.split('');
    if (!r || !g || !b) return null;
    return {
      r: Number.parseInt(r + r, 16),
      g: Number.parseInt(g + g, 16),
      b: Number.parseInt(b + b, 16),
    };
  }

  if (hex.length === 6 || hex.length === 8) {
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
    };
  }

  return null;
}

function toRgba(color: RgbColor, alpha: number): string {
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${alpha.toFixed(3)})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
