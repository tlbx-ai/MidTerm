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

const FONT_LOAD_SAMPLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BUNDLED_TERMINAL_FONT_FAMILIES = [
  DEFAULT_TERMINAL_FONT_FAMILY,
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
