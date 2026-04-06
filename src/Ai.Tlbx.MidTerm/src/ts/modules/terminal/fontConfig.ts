/**
 * Terminal Font Config Module
 *
 * Shared helpers for resolving, building, and loading terminal font settings.
 */

import { TERMINAL_FONT_STACK } from '../../constants';
import { $currentSettings } from '../../stores';

export const DEFAULT_TERMINAL_FONT_FAMILY = 'Cascadia Code';
export const DEFAULT_TERMINAL_LINE_HEIGHT = 1;
export const DEFAULT_TERMINAL_LETTER_SPACING = 0;
export const DEFAULT_TERMINAL_FONT_WEIGHT = 'normal';
export const DEFAULT_TERMINAL_FONT_WEIGHT_BOLD = 'bold';
export const TERMINAL_FONT_WEIGHT_OPTIONS = [
  DEFAULT_TERMINAL_FONT_WEIGHT,
  DEFAULT_TERMINAL_FONT_WEIGHT_BOLD,
] as const;

const FONT_LOAD_SAMPLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BUNDLED_TERMINAL_FONT_FAMILIES = [
  DEFAULT_TERMINAL_FONT_FAMILY,
  'Cascadia Code SemiBold',
  'JetBrains Mono',
  'Terminus',
] as const;

function quoteFontFamily(fontFamily: string): string {
  return `"${fontFamily.replace(/["\\]/g, '\\$&')}"`;
}

export function getBundledTerminalFontFamilies(): readonly string[] {
  return BUNDLED_TERMINAL_FONT_FAMILIES;
}

export function getConfiguredTerminalFontFamily(): string {
  return $currentSettings.get()?.fontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY;
}

export function buildTerminalFontStack(
  fontFamily: string = getConfiguredTerminalFontFamily(),
): string {
  return `'${fontFamily.replace(/'/g, "\\'")}', ${TERMINAL_FONT_STACK}`;
}

export async function ensureTerminalFontLoaded(
  fontFamily: string,
  fontSize: number,
): Promise<void> {
  if (typeof document === 'undefined' || typeof document.fonts.load !== 'function') {
    return;
  }

  try {
    await document.fonts.load(`${fontSize}px ${quoteFontFamily(fontFamily)}`, FONT_LOAD_SAMPLE);
  } catch {
    // Font loading is best-effort only.
  }
}

export function normalizeTerminalLetterSpacing(value: number | null | undefined): number {
  const finiteValue =
    typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_TERMINAL_LETTER_SPACING;
  return Math.min(10, Math.max(-2, Math.round(finiteValue * 100) / 100));
}

export function normalizeTerminalFontWeight(
  value: string | null | undefined,
  fallback: (typeof TERMINAL_FONT_WEIGHT_OPTIONS)[number] = DEFAULT_TERMINAL_FONT_WEIGHT,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }

  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === DEFAULT_TERMINAL_FONT_WEIGHT_BOLD) {
    return DEFAULT_TERMINAL_FONT_WEIGHT_BOLD;
  }

  if (normalized === DEFAULT_TERMINAL_FONT_WEIGHT) {
    return DEFAULT_TERMINAL_FONT_WEIGHT;
  }

  const numericWeight = Number.parseInt(trimmed, 10);
  if (Number.isFinite(numericWeight) && numericWeight >= 1 && numericWeight <= 1000) {
    return String(numericWeight);
  }

  return fallback;
}
