/**
 * Background Appearance Module
 *
 * Applies wallpaper and pane transparency without fading text content.
 */

import type { MidTermSettingsPublic } from '../../types';
import { getCssThemePalette } from './cssThemes';
import {
  isMobileBackgroundSuppressed,
  isMobilePresentationContext,
  shouldRenderBackgroundImage,
} from './backgroundVisibility';

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
const BACKGROUND_KEN_BURNS_KEYFRAME_STEPS = 64;

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface BackgroundKenBurnsState {
  enabled: boolean;
  root: HTMLElement | null;
  targetScale: number;
  speedPxPerSecond: number;
  styleElement: HTMLStyleElement | null;
  styleElementDocument: Document | null;
  animationVersion: number;
  resizeListenerWindow: Window | null;
  resizeFrameId: number | null;
  activeAnimationKey: string | null;
  activeAnimationRoot: HTMLElement | null;
  activeAnimationDocument: Document | null;
}

const backgroundKenBurnsState: BackgroundKenBurnsState = {
  enabled: false,
  root: null,
  targetScale: 1,
  speedPxPerSecond: 0,
  styleElement: null,
  styleElementDocument: null,
  animationVersion: 0,
  resizeListenerWindow: null,
  resizeFrameId: null,
  activeAnimationKey: null,
  activeAnimationRoot: null,
  activeAnimationDocument: null,
};

export function getBackgroundImageUrl(revision: number): string {
  return `/api/settings/background-image?v=${encodeURIComponent(`${revision}`)}`;
}

export function applyBackgroundAppearance(settings: MidTermSettingsPublic): void {
  const root = document.documentElement;
  const palette = getCssThemePalette(settings.theme);
  const mobilePresentation = isMobilePresentationContext();
  const uiTransparency = mobilePresentation ? 0 : clamp(settings.uiTransparency, 0, 100);
  const terminalTransparency = mobilePresentation
    ? 0
    : clamp(settings.terminalTransparency ?? settings.uiTransparency, 0, 100);
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

  const hasImage = shouldRenderBackgroundImage(settings);

  root.style.setProperty(
    '--app-background-image',
    hasImage ? `url("${getBackgroundImageUrl(settings.backgroundImageRevision)}")` : 'none',
  );
  root.style.setProperty('--app-background-size', 'cover');
  root.style.setProperty('--app-background-repeat', 'no-repeat');
  root.style.setProperty('--app-background-position', 'center center');
  syncBackgroundKenBurnsEffect(root, settings, hasImage);
  document.body.classList.toggle('has-app-background', hasImage);
  document.body.classList.toggle(
    'hide-app-background-on-mobile',
    isMobileBackgroundSuppressed(settings),
  );
  document.body.classList.toggle('opaque-terminal-surfaces', terminalTransparency === 0);
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
  ensureBackgroundKenBurnsResizeListener();
  const enabled = hasImage && settings.backgroundKenBurnsEnabled;
  const scale = clamp(settings.backgroundKenBurnsZoomPercent / 100, 1.5, 3);
  const speedPxPerSecond = clamp(settings.backgroundKenBurnsSpeedPxPerSecond, 0, 120);
  const staticScale = enabled ? scale : 1;

  root.style.setProperty('--app-background-transform', buildBackgroundTransform(0, 0, staticScale));

  if (!enabled) {
    stopBackgroundKenBurnsEffect();
    return;
  }

  backgroundKenBurnsState.enabled = true;
  backgroundKenBurnsState.root = root;
  backgroundKenBurnsState.targetScale = scale;
  backgroundKenBurnsState.speedPxPerSecond = speedPxPerSecond;
  refreshBackgroundKenBurnsAnimation();
}

function stopBackgroundKenBurnsEffect(): void {
  backgroundKenBurnsState.enabled = false;
  backgroundKenBurnsState.root = null;
  backgroundKenBurnsState.speedPxPerSecond = 0;
  backgroundKenBurnsState.targetScale = 1;
  clearBackgroundKenBurnsAnimation();
}

function ensureBackgroundKenBurnsResizeListener(): void {
  if (typeof window === 'undefined' || backgroundKenBurnsState.resizeListenerWindow === window) {
    return;
  }

  window.addEventListener('resize', scheduleBackgroundKenBurnsAnimationRefresh, { passive: true });
  backgroundKenBurnsState.resizeListenerWindow = window;
}

function scheduleBackgroundKenBurnsAnimationRefresh(): void {
  if (!backgroundKenBurnsState.enabled) {
    return;
  }

  if (backgroundKenBurnsState.resizeFrameId !== null) {
    return;
  }

  if (typeof requestAnimationFrame === 'function') {
    backgroundKenBurnsState.resizeFrameId = requestAnimationFrame(() => {
      backgroundKenBurnsState.resizeFrameId = null;
      refreshBackgroundKenBurnsAnimation();
    });
    return;
  }

  refreshBackgroundKenBurnsAnimation();
}

function refreshBackgroundKenBurnsAnimation(): void {
  const root = backgroundKenBurnsState.root;
  if (!backgroundKenBurnsState.enabled || !root) {
    return;
  }

  const scale = backgroundKenBurnsState.targetScale;
  root.style.setProperty('--app-background-transform', buildBackgroundTransform(0, 0, scale));

  const orbitRadius =
    backgroundKenBurnsState.speedPxPerSecond > 0 ? computeBackgroundKenBurnsOrbitRadius(scale) : 0;

  if (backgroundKenBurnsState.speedPxPerSecond <= 0 || orbitRadius < 0.5) {
    clearBackgroundKenBurnsAnimation();
    return;
  }

  const durationSeconds = clamp(
    (2 * Math.PI * orbitRadius) / backgroundKenBurnsState.speedPxPerSecond,
    0.1,
    86400,
  );
  const animationKey = `${scale.toFixed(3)}|${orbitRadius.toFixed(2)}|${durationSeconds.toFixed(3)}`;

  if (
    backgroundKenBurnsState.activeAnimationKey === animationKey &&
    backgroundKenBurnsState.activeAnimationRoot === root &&
    backgroundKenBurnsState.activeAnimationDocument === document &&
    root.style.getPropertyValue('--app-background-animation') !== 'none' &&
    root.style.getPropertyValue('--app-background-animation') !== '' &&
    backgroundKenBurnsState.styleElement?.textContent
  ) {
    return;
  }

  const animationName = `midterm-app-background-ken-burns-${++backgroundKenBurnsState.animationVersion}`;
  const keyframes = buildBackgroundKenBurnsKeyframes(animationName, orbitRadius, scale);
  const animationValue = `${animationName} ${durationSeconds.toFixed(3)}s linear infinite`;

  ensureBackgroundKenBurnsStyleElement().textContent = keyframes;
  root.style.setProperty('--app-background-animation', animationValue);
  backgroundKenBurnsState.activeAnimationKey = animationKey;
  backgroundKenBurnsState.activeAnimationRoot = root;
  backgroundKenBurnsState.activeAnimationDocument = document;
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

function ensureBackgroundKenBurnsStyleElement(): HTMLStyleElement {
  if (
    backgroundKenBurnsState.styleElement &&
    backgroundKenBurnsState.styleElementDocument === document
  ) {
    return backgroundKenBurnsState.styleElement;
  }

  const styleElement = document.createElement('style');
  styleElement.setAttribute('data-midterm-background-ken-burns', 'true');
  document.head.appendChild(styleElement);
  backgroundKenBurnsState.styleElement = styleElement;
  backgroundKenBurnsState.styleElementDocument = document;
  return styleElement;
}

function clearBackgroundKenBurnsAnimation(): void {
  if (
    backgroundKenBurnsState.resizeFrameId !== null &&
    typeof cancelAnimationFrame === 'function'
  ) {
    cancelAnimationFrame(backgroundKenBurnsState.resizeFrameId);
  }

  backgroundKenBurnsState.resizeFrameId = null;
  document.documentElement.style.setProperty('--app-background-animation', 'none');
  backgroundKenBurnsState.activeAnimationKey = null;
  backgroundKenBurnsState.activeAnimationRoot = null;
  backgroundKenBurnsState.activeAnimationDocument = null;

  if (backgroundKenBurnsState.styleElement) {
    backgroundKenBurnsState.styleElement.textContent = '';
  }
}

function buildBackgroundKenBurnsKeyframes(
  animationName: string,
  orbitRadius: number,
  scale: number,
): string {
  const frames: string[] = [];

  for (let index = 0; index <= BACKGROUND_KEN_BURNS_KEYFRAME_STEPS; index += 1) {
    const progress = index / BACKGROUND_KEN_BURNS_KEYFRAME_STEPS;
    const angle = progress * Math.PI * 2;
    const offsetX = Math.cos(angle) * orbitRadius;
    const offsetY = Math.sin(angle) * orbitRadius;
    frames.push(
      `  ${(progress * 100).toFixed(3)}% { transform: ${buildBackgroundTransform(offsetX, offsetY, scale)}; }`,
    );
  }

  return `@keyframes ${animationName} {\n${frames.join('\n')}\n}`;
}

function buildBackgroundTransform(offsetX: number, offsetY: number, scale: number): string {
  return `translate3d(${offsetX.toFixed(2)}px, ${offsetY.toFixed(2)}px, 0) scale(${scale.toFixed(3)})`;
}
