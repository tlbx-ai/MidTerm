/**
 * Touch Controller Bar
 *
 * Manages the visibility and lifecycle of the touch controller bar.
 */

import { CSS_CLASSES, SELECTORS } from './constants';
import { initModifiers, clearModifiers } from './modifiers';
import { initEvents, teardownEvents } from './events';
import {
  shouldShowTouchController,
  setupPointerDetection,
  teardownPointerDetection,
} from './detection';

let controllerElement: HTMLElement | null = null;
let isInitialized = false;

/**
 * Enable VirtualKeyboard API for env(keyboard-inset-height) support
 */
function setupVirtualKeyboard(): void {
  if ('virtualKeyboard' in navigator) {
    (
      navigator as Navigator & { virtualKeyboard: { overlaysContent: boolean } }
    ).virtualKeyboard.overlaysContent = true;
  }
}

/**
 * Use Visual Viewport API to position bar above keyboard (fallback)
 */
function setupKeyboardPositioning(): void {
  if (!window.visualViewport || !controllerElement) return;

  const updatePosition = (): void => {
    if (!controllerElement) return;

    const viewport = window.visualViewport!;
    const keyboardHeight = window.innerHeight - viewport.height - viewport.offsetTop;

    if (keyboardHeight > 100) {
      controllerElement.style.bottom = keyboardHeight + 'px';
    } else {
      controllerElement.style.bottom = '';
    }
  };

  window.visualViewport.addEventListener('resize', updatePosition);
  window.visualViewport.addEventListener('scroll', updatePosition);
}

/**
 * Update terminal area padding to account for touch bar height
 */
export function updateTerminalPadding(): void {
  if (!controllerElement) return;

  const terminalsArea = document.querySelector<HTMLElement>('.terminals-area');
  if (!terminalsArea) return;

  if (controllerElement.classList.contains(CSS_CLASSES.visible)) {
    const barHeight = controllerElement.offsetHeight;
    terminalsArea.style.paddingBottom = barHeight + 'px';
  } else {
    terminalsArea.style.paddingBottom = '';
  }
}

/**
 * Initialize the touch controller bar
 */
export function initTouchController(): void {
  if (isInitialized) return;

  controllerElement = document.querySelector<HTMLElement>(SELECTORS.controller);
  if (!controllerElement) {
    return;
  }

  setupVirtualKeyboard();
  initModifiers(controllerElement);
  initEvents(controllerElement);

  setupPointerDetection(handlePointerChange);
  setupKeyboardPositioning();

  updateVisibility();

  window.addEventListener('resize', handleResize);

  isInitialized = true;
}

/**
 * Destroy the touch controller
 */
export function destroyTouchController(): void {
  if (!isInitialized) return;

  teardownEvents();
  teardownPointerDetection();
  window.removeEventListener('resize', handleResize);

  if (controllerElement) {
    controllerElement.classList.remove(CSS_CLASSES.visible);
  }
  document.body.classList.remove(CSS_CLASSES.touchMode);

  controllerElement = null;
  isInitialized = false;
}

/**
 * Show the touch controller
 */
export function showTouchController(): void {
  if (!controllerElement) return;
  controllerElement.classList.add(CSS_CLASSES.visible);
  document.body.classList.add(CSS_CLASSES.touchMode);
  requestAnimationFrame(updateTerminalPadding);
}

/**
 * Hide the touch controller
 */
export function hideTouchController(): void {
  if (!controllerElement) return;
  controllerElement.classList.remove(CSS_CLASSES.visible);
  document.body.classList.remove(CSS_CLASSES.touchMode);
  clearModifiers();
  updateTerminalPadding();
}

/**
 * Update visibility based on current device state
 */
export function updateVisibility(): void {
  if (shouldShowTouchController()) {
    showTouchController();
  } else {
    hideTouchController();
  }
}

function handlePointerChange(hasPrecisePointer: boolean): void {
  if (hasPrecisePointer) {
    hideTouchController();
  } else {
    updateVisibility();
  }
}

function handleResize(): void {
  updateVisibility();
}
