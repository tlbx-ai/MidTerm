/**
 * Keyboard/Pointing Device Detection
 *
 * Detects whether device has attached keyboard/mouse to hide touch bar.
 */

import { MOBILE_BREAKPOINT } from '../../constants';

type DetectionCallback = (hasPrecisePointer: boolean) => void;

let mediaQueryList: MediaQueryList | null = null;
let callback: DetectionCallback | null = null;

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
  if (!isTouchDevice()) {
    return false;
  }

  if (hasPrecisePointer()) {
    return false;
  }

  if (window.innerWidth > MOBILE_BREAKPOINT && !isTouchDevice()) {
    return false;
  }

  return true;
}

/**
 * Set up listener for pointer capability changes
 * (e.g., iPad keyboard connected/disconnected)
 */
export function setupPointerDetection(onChangeCallback: DetectionCallback): void {
  callback = onChangeCallback;

  mediaQueryList = window.matchMedia('(hover: hover) and (pointer: fine)');

  const handleChange = (event: MediaQueryListEvent): void => {
    if (callback) {
      callback(event.matches);
    }
  };

  mediaQueryList.addEventListener('change', handleChange);

  onChangeCallback(hasPrecisePointer());
}

/**
 * Clean up detection listeners
 */
export function teardownPointerDetection(): void {
  if (mediaQueryList) {
    const handleChange = (): void => {};
    mediaQueryList.removeEventListener('change', handleChange);
    mediaQueryList = null;
  }
  callback = null;
}
