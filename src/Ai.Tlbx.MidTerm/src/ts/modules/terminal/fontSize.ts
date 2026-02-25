/**
 * Terminal Font Size Module
 *
 * Resolves effective xterm.js font sizes from user-configured settings.
 */

import { MOBILE_BREAKPOINT } from '../../constants';

const MOBILE_FONT_SIZE_DELTA = 3;
const MIN_TERMINAL_FONT_SIZE = 1;

/**
 * Resolve effective xterm font size for the current viewport.
 * Mobile uses 3px smaller than the configured value.
 */
export function getEffectiveTerminalFontSize(
  configuredFontSize: number,
  viewportWidth: number = window.innerWidth,
): number {
  if (viewportWidth <= MOBILE_BREAKPOINT) {
    return Math.max(configuredFontSize - MOBILE_FONT_SIZE_DELTA, MIN_TERMINAL_FONT_SIZE);
  }

  return configuredFontSize;
}
