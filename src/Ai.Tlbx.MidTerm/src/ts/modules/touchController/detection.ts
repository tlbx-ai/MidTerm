/**
 * Keyboard/Pointing Device Detection
 *
 * Detects whether device has attached keyboard/mouse to hide touch bar.
 */

import { MOBILE_BREAKPOINT } from '../../constants';

/**
 * Check if device has a precise pointing device (mouse/trackpad)
 */
export function hasPrecisePointer(): boolean {
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    return true;
  }

  if (window.matchMedia('(any-pointer: fine)').matches) {
    if (window.matchMedia('(any-hover: hover)').matches) {
      return true;
    }
  }

  return false;
}

/**
 * Check if device is primarily touch-based
 */
export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/**
 * Determine if touch controller should be shown
 */
export function shouldShowTouchController(): boolean {
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
}
