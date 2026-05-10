import { $isMainBrowser } from '../../stores';
import { autoResizeAllTerminalsImmediate, rescaleAllTerminalsImmediate } from './scaling';
import { setMobileVerticalStability } from './mobileVerticalStability';

const DEFAULT_KEYBOARD_RATIO = 0.42;
const MIN_KEYBOARD_HEIGHT_PX = 220;
const MAX_KEYBOARD_HEIGHT_PX = 360;

let active = false;
let keyboardHeight = 0;

declare global {
  interface Window {
    mtDevSoftKeyboard?: {
      show: (height?: number) => void;
      hide: () => void;
      toggle: () => void;
      isActive: () => boolean;
    };
  }
}

export function initDevSoftKeyboardSimulator(): void {
  const button = document.getElementById('dev-soft-keyboard-toggle') as HTMLButtonElement | null;
  const keyboard = document.getElementById('dev-soft-keyboard');
  if (!button || !keyboard) return;

  button.addEventListener('click', () => {
    if (active) {
      hideDevSoftKeyboard();
    } else {
      showDevSoftKeyboard();
    }
  });

  window.addEventListener('resize', () => {
    if (active) {
      showDevSoftKeyboard(keyboardHeight);
    }
  });

  window.mtDevSoftKeyboard = {
    show: showDevSoftKeyboard,
    hide: hideDevSoftKeyboard,
    toggle: () => {
      if (active) {
        hideDevSoftKeyboard();
      } else {
        showDevSoftKeyboard();
      }
    },
    isActive: () => active,
  };
}

export function showDevSoftKeyboard(height = calculateKeyboardHeight()): void {
  const appEl = document.querySelector<HTMLElement>('.terminal-page');
  const button = document.getElementById('dev-soft-keyboard-toggle') as HTMLButtonElement | null;
  const keyboard = document.getElementById('dev-soft-keyboard');
  const viewportHeight = Math.max(240, window.innerHeight - height);

  active = true;
  keyboardHeight = height;
  document.documentElement.style.setProperty('--midterm-dev-soft-keyboard-height', `${height}px`);
  document.documentElement.style.setProperty(
    '--midterm-visual-viewport-height',
    `${viewportHeight}px`,
  );
  document.documentElement.style.setProperty('--midterm-visual-viewport-offset-top', '0px');
  document.documentElement.style.setProperty('--midterm-soft-keyboard-height', `${height}px`);
  document.documentElement.style.height = `${viewportHeight}px`;
  document.documentElement.style.maxHeight = `${viewportHeight}px`;
  document.body.style.height = `${viewportHeight}px`;
  document.body.style.maxHeight = `${viewportHeight}px`;
  document.body.classList.add(
    'keyboard-visible',
    'mobile-terminal-vertical-stable',
    'dev-soft-keyboard-active',
  );

  if (appEl) {
    appEl.style.top = '0px';
    appEl.style.bottom = 'auto';
    appEl.style.height = `${viewportHeight}px`;
    appEl.style.maxHeight = `${viewportHeight}px`;
  }
  if (keyboard) {
    keyboard.hidden = false;
    keyboard.setAttribute('aria-hidden', 'false');
  }
  if (button) {
    button.setAttribute('aria-pressed', 'true');
  }

  setMobileVerticalStability(true);
  dispatchViewportSimulationChange();
}

export function hideDevSoftKeyboard(): void {
  const appEl = document.querySelector<HTMLElement>('.terminal-page');
  const button = document.getElementById('dev-soft-keyboard-toggle') as HTMLButtonElement | null;
  const keyboard = document.getElementById('dev-soft-keyboard');

  active = false;
  keyboardHeight = 0;
  document.documentElement.style.removeProperty('--midterm-dev-soft-keyboard-height');
  document.documentElement.style.removeProperty('--midterm-visual-viewport-height');
  document.documentElement.style.removeProperty('--midterm-visual-viewport-offset-top');
  document.documentElement.style.removeProperty('--midterm-soft-keyboard-height');
  document.documentElement.style.height = '';
  document.documentElement.style.maxHeight = '';
  document.body.style.height = '';
  document.body.style.maxHeight = '';
  document.body.classList.remove(
    'keyboard-visible',
    'mobile-terminal-vertical-stable',
    'dev-soft-keyboard-active',
  );

  if (appEl) {
    appEl.style.top = '';
    appEl.style.bottom = '';
    appEl.style.height = '';
    appEl.style.maxHeight = '';
  }
  if (keyboard) {
    keyboard.hidden = true;
    keyboard.setAttribute('aria-hidden', 'true');
  }
  if (button) {
    button.setAttribute('aria-pressed', 'false');
  }

  setMobileVerticalStability(false);
  dispatchViewportSimulationChange();
}

function calculateKeyboardHeight(): number {
  return Math.round(
    Math.min(
      MAX_KEYBOARD_HEIGHT_PX,
      Math.max(MIN_KEYBOARD_HEIGHT_PX, window.innerHeight * DEFAULT_KEYBOARD_RATIO),
    ),
  );
}

function dispatchViewportSimulationChange(): void {
  window.dispatchEvent(new Event('midterm:visual-viewport-changed'));
  if ($isMainBrowser.get()) {
    autoResizeAllTerminalsImmediate();
  } else {
    requestAnimationFrame(rescaleAllTerminalsImmediate);
  }
}
