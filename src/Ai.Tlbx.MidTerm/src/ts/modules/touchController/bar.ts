/**
 * Touch Controller Bar
 *
 * Manages the visibility and lifecycle of the touch controller bar.
 */

import { CSS_CLASSES, SELECTORS } from './constants';
import { initModifiers, clearModifiers } from './modifiers';
import { initEvents, teardownEvents } from './events';
import { initPopups, closePopup } from './popups';
import { initGestures, teardownGestures } from './gestures';
import {
  shouldShowTouchController,
  setupPointerDetection,
  teardownPointerDetection,
} from './detection';
import { rescaleAllTerminals } from '../terminal/scaling';
import { $currentSettings } from '../../stores';

let controllerElement: HTMLElement | null = null;
let isInitialized = false;
let userDismissed = false;
let unsubscribeSettings: (() => void) | null = null;

/**
 * Initialize the touch controller bar
 */
export function initTouchController(): void {
  if (isInitialized) return;

  controllerElement = document.querySelector<HTMLElement>(SELECTORS.controller);
  if (!controllerElement) {
    return;
  }

  initModifiers(controllerElement);
  initEvents(controllerElement);
  initPopups();
  initGestures();

  setupPointerDetection(handlePointerChange);

  updateVisibility();

  window.addEventListener('resize', handleResize);

  unsubscribeSettings = $currentSettings.subscribe((settings) => {
    if (!settings) return;
    const mode = settings.inputMode;
    if (mode === 'smartinput' || mode === 'both') {
      // Smart input module handles embedding the touch controller
      return;
    }
    updateVisibility();
  });

  const kbObserver = new MutationObserver(() => {
    if (document.body.classList.contains('keyboard-visible')) {
      closePopup();
    }
  });
  kbObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  isInitialized = true;
}

/**
 * Destroy the touch controller
 */
export function destroyTouchController(): void {
  if (!isInitialized) return;

  teardownEvents();
  teardownGestures();
  closePopup();
  teardownPointerDetection();
  window.removeEventListener('resize', handleResize);
  if (unsubscribeSettings) {
    unsubscribeSettings();
    unsubscribeSettings = null;
  }

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
  requestAnimationFrame(rescaleAllTerminals);
}

/**
 * Hide the touch controller
 */
export function hideTouchController(): void {
  if (!controllerElement) return;
  controllerElement.classList.remove(CSS_CLASSES.visible);
  document.body.classList.remove(CSS_CLASSES.touchMode);
  clearModifiers();
  requestAnimationFrame(rescaleAllTerminals);
}

/**
 * Update visibility based on current device state
 */
export function updateVisibility(): void {
  if (userDismissed) return;
  const mode = $currentSettings.get()?.inputMode;
  if (mode === 'smartinput' || mode === 'both') {
    return;
  }
  if (shouldShowTouchController()) {
    showTouchController();
  } else {
    hideTouchController();
  }
}

/**
 * User-initiated dismiss of the touch bar
 */
export function dismissTouchController(): void {
  userDismissed = true;
  hideTouchController();
  const showBtn = document.getElementById('btn-show-touchbar');
  if (showBtn) showBtn.classList.remove('hidden');
}

/**
 * Restore touch bar after user dismiss
 */
export function restoreTouchController(): void {
  userDismissed = false;
  updateVisibility();
  const showBtn = document.getElementById('btn-show-touchbar');
  if (showBtn) showBtn.classList.add('hidden');
}

function handlePointerChange(hasPrecisePointer: boolean): void {
  if (hasPrecisePointer) {
    userDismissed = false;
    hideTouchController();
    const showBtn = document.getElementById('btn-show-touchbar');
    if (showBtn) showBtn.classList.add('hidden');
  } else {
    updateVisibility();
  }
}

function handleResize(): void {
  updateVisibility();
}
