/**
 * Background Appearance Module
 *
 * Applies wallpaper and pane transparency without fading text content.
 */

import type { MidTermSettingsPublic } from '../../types';
import { getCssThemePalette } from './cssThemes';

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
  { name: '--bg-primary-opaque', source: '--bg-primary' },
  { name: '--bg-elevated-opaque', source: '--bg-elevated' },
  { name: '--bg-sidebar-opaque', source: '--bg-sidebar' },
  { name: '--bg-settings-opaque', source: '--bg-settings' },
  { name: '--bg-dropdown-opaque', source: '--bg-dropdown' },
  { name: '--bg-session-hover-opaque', source: '--bg-session-hover' },
  { name: '--bg-session-active-opaque', source: '--bg-session-active' },
  { name: '--bg-hover-opaque', source: '--bg-hover' },
  { name: '--bg-active-opaque', source: '--bg-active' },
];

const DERIVED_BACKGROUND_VARIABLES: Array<{
  name: string;
  source: string;
  mode: 'ui' | 'terminal';
  response?: number;
}> = [
  { name: '--terminal-canvas-background', source: '--bg-terminal', mode: 'terminal' },
  { name: '--terminal-ui-background', source: '--bg-terminal', mode: 'ui' },
  { name: '--text-input-background', source: '--bg-input', mode: 'ui', response: 0.2 },
  {
    name: '--sidebar-item-hover-background',
    source: '--bg-session-hover',
    mode: 'ui',
    response: 0.6,
  },
  {
    name: '--sidebar-item-active-background',
    source: '--bg-session-active',
    mode: 'ui',
    response: 0.6,
  },
];

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface BackgroundKenBurnsState {
  frameId: number | null;
  enabled: boolean;
  targetScale: number;
  speedPxPerSecond: number;
  orbitRadius: number;
  angleRadians: number;
  lastTimestamp: number | null;
}

const backgroundKenBurnsState: BackgroundKenBurnsState = {
  frameId: null,
  enabled: false,
  targetScale: 1,
  speedPxPerSecond: 0,
  orbitRadius: 0,
  angleRadians: 0,
  lastTimestamp: null,
};

export function getBackgroundImageUrl(revision: number): string {
  return `/api/settings/background-image?v=${encodeURIComponent(`${revision}`)}`;
}

export function applyBackgroundAppearance(settings: MidTermSettingsPublic): void {
  const root = document.documentElement;
  const palette = getCssThemePalette(settings.theme);
  const uiTransparency = clamp(settings.uiTransparency, 0, 100);
  const terminalTransparency = clamp(
    settings.terminalTransparency ?? settings.uiTransparency,
    0,
    100,
  );
  const uiBaseAlpha = Math.max(0, 1 - uiTransparency / 100);

  for (const variable of OPAQUE_SURFACE_VARIABLES) {
    const value = palette[variable.source];
    if (!value) {
      continue;
    }

    root.style.setProperty(variable.name, value);
  }

  for (const variable of UI_BACKGROUND_VARIABLES) {
    const value = palette[variable.name];
    const rgb = parseColor(value);
    if (!rgb) {
      continue;
    }

    const alpha = clamp(uiBaseAlpha * (1 + (variable.boost ?? 0)), 0, 1);
    root.style.setProperty(variable.name, toRgba(rgb, alpha));
  }

  for (const variable of DERIVED_BACKGROUND_VARIABLES) {
    const value = palette[variable.source];
    const rgb = parseColor(value);
    if (!rgb) {
      continue;
    }

    const transparency = variable.mode === 'terminal' ? terminalTransparency : uiTransparency;
    root.style.setProperty(
      variable.name,
      toRgba(rgb, transparencyToAlpha(transparency, variable.response ?? 1)),
    );
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
  root.style.setProperty('--app-background-size', 'cover');
  root.style.setProperty('--app-background-repeat', 'no-repeat');
  root.style.setProperty('--app-background-position', 'center center');
  syncBackgroundKenBurnsEffect(root, settings, hasImage);
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

function transparencyToAlpha(transparency: number, response: number): number {
  return clamp(1 - (clamp(transparency, 0, 100) / 100) * response, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function syncBackgroundKenBurnsEffect(
  root: HTMLElement,
  settings: MidTermSettingsPublic,
  hasImage: boolean,
): void {
  const enabled = hasImage && settings.backgroundKenBurnsEnabled;
  const scale = clamp(settings.backgroundKenBurnsZoomPercent / 100, 1.5, 3);
  const speedPxPerSecond = clamp(settings.backgroundKenBurnsSpeedPxPerSecond, 0, 120);
  const wasEnabled = backgroundKenBurnsState.enabled;

  root.style.setProperty('--app-background-scale', enabled ? scale.toFixed(3) : '1');

  if (!enabled) {
    root.style.setProperty('--app-background-offset-x', '0px');
    root.style.setProperty('--app-background-offset-y', '0px');
    stopBackgroundKenBurnsEffect();
    return;
  }

  if (!wasEnabled) {
    backgroundKenBurnsState.orbitRadius = 0;
    backgroundKenBurnsState.angleRadians = 0;
    root.style.setProperty('--app-background-offset-x', '0px');
    root.style.setProperty('--app-background-offset-y', '0px');
  }

  backgroundKenBurnsState.enabled = true;
  backgroundKenBurnsState.targetScale = scale;
  backgroundKenBurnsState.speedPxPerSecond = speedPxPerSecond;

  if (backgroundKenBurnsState.frameId !== null) {
    return;
  }

  if (typeof requestAnimationFrame !== 'function') {
    return;
  }

  backgroundKenBurnsState.lastTimestamp = null;
  backgroundKenBurnsState.frameId = requestAnimationFrame(stepBackgroundKenBurnsEffect);
}

function stopBackgroundKenBurnsEffect(): void {
  backgroundKenBurnsState.enabled = false;
  backgroundKenBurnsState.speedPxPerSecond = 0;
  backgroundKenBurnsState.orbitRadius = 0;
  backgroundKenBurnsState.angleRadians = 0;
  backgroundKenBurnsState.lastTimestamp = null;

  if (backgroundKenBurnsState.frameId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(backgroundKenBurnsState.frameId);
  }

  backgroundKenBurnsState.frameId = null;
}

function stepBackgroundKenBurnsEffect(timestamp: number): void {
  backgroundKenBurnsState.frameId = null;
  if (!backgroundKenBurnsState.enabled) {
    return;
  }

  const root = document.documentElement;
  const lastTimestamp = backgroundKenBurnsState.lastTimestamp;
  const dtSeconds = lastTimestamp === null ? 0 : clamp((timestamp - lastTimestamp) / 1000, 0, 0.1);
  backgroundKenBurnsState.lastTimestamp = timestamp;

  const targetRadius =
    backgroundKenBurnsState.speedPxPerSecond > 0
      ? computeBackgroundKenBurnsOrbitRadius(backgroundKenBurnsState.targetScale)
      : 0;

  backgroundKenBurnsState.orbitRadius = easeTowards(
    backgroundKenBurnsState.orbitRadius,
    targetRadius,
    dtSeconds,
    3.5,
  );

  if (
    backgroundKenBurnsState.speedPxPerSecond > 0 &&
    backgroundKenBurnsState.orbitRadius >= 0.5 &&
    dtSeconds > 0
  ) {
    backgroundKenBurnsState.angleRadians +=
      (backgroundKenBurnsState.speedPxPerSecond / backgroundKenBurnsState.orbitRadius) * dtSeconds;
    if (backgroundKenBurnsState.angleRadians >= Math.PI * 2) {
      backgroundKenBurnsState.angleRadians %= Math.PI * 2;
    }
  }

  const offsetX =
    backgroundKenBurnsState.orbitRadius > 0
      ? Math.cos(backgroundKenBurnsState.angleRadians) * backgroundKenBurnsState.orbitRadius
      : 0;
  const offsetY =
    backgroundKenBurnsState.orbitRadius > 0
      ? Math.sin(backgroundKenBurnsState.angleRadians) * backgroundKenBurnsState.orbitRadius
      : 0;

  root.style.setProperty('--app-background-offset-x', `${offsetX.toFixed(2)}px`);
  root.style.setProperty('--app-background-offset-y', `${offsetY.toFixed(2)}px`);

  if (typeof requestAnimationFrame === 'function') {
    backgroundKenBurnsState.frameId = requestAnimationFrame(stepBackgroundKenBurnsEffect);
  }
}

function computeBackgroundKenBurnsOrbitRadius(scale: number): number {
  const width =
    window.innerWidth || document.documentElement.clientWidth || document.body.clientWidth || 0;
  const height =
    window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight || 0;

  if (width <= 0 || height <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(width, height) * (scale - 1) * 0.46);
}

function easeTowards(current: number, target: number, dtSeconds: number, response: number): number {
  if (dtSeconds <= 0) {
    return current;
  }

  return current + (target - current) * (1 - Math.exp(-response * dtSeconds));
}
