/**
 * Touch Event Handlers
 *
 * Manages touch interactions for the controller bar.
 * Includes popup triggers, haptic feedback, and long-press alternates.
 */

import { $activeSessionId } from '../../stores';
import { sendInput } from '../comms/muxChannel';
import { KEY_SEQUENCES, KEY_LABELS } from './constants';
import { toggleModifier, consumeModifiers, getModifierCode, type ModifierKey } from './modifiers';
import { togglePopup } from './popups';

let controllerElement: HTMLElement | null = null;

let longPressTimer: number | null = null;
let alternatesPopup: HTMLElement | null = null;

const LONG_PRESS_DELAY = 400;

const KEY_ALTERNATES: Record<string, string[]> = {
  lbracket: ['rbracket', 'lbrace', 'rbrace'],
  rbracket: ['lbracket', 'lbrace', 'rbrace'],
  lbrace: ['rbrace', 'lbracket', 'rbracket'],
  rbrace: ['lbrace', 'lbracket', 'rbracket'],
  lparen: ['rparen', 'langle', 'rangle'],
  rparen: ['lparen', 'langle', 'rangle'],
  langle: ['rangle', 'lparen', 'rparen'],
  rangle: ['langle', 'lparen', 'rparen'],
  squote: ['dquote', 'backtick'],
  dquote: ['squote', 'backtick'],
  backtick: ['squote', 'dquote'],
  pipe: ['backslash', 'slash'],
  backslash: ['pipe', 'slash'],
  slash: ['pipe', 'backslash'],
  ctrlc: ['ctrld', 'ctrlz'],
  ctrld: ['ctrlc', 'ctrlz'],
  ctrlz: ['ctrlc', 'ctrld'],
};

/**
 * Initialize event handlers for touch controller
 */
export function initEvents(container: HTMLElement): void {
  controllerElement = container;

  container.addEventListener('touchstart', handleTouchStart, { passive: false });
  container.addEventListener('touchend', handleTouchEnd, { passive: false });
  container.addEventListener('touchmove', handleTouchMove, { passive: true });
  container.addEventListener('click', handleClick);
}

/**
 * Clean up event handlers
 */
export function teardownEvents(): void {
  if (controllerElement) {
    controllerElement.removeEventListener('touchstart', handleTouchStart);
    controllerElement.removeEventListener('touchend', handleTouchEnd);
    controllerElement.removeEventListener('touchmove', handleTouchMove);
    controllerElement.removeEventListener('click', handleClick);
  }
  controllerElement = null;
  cancelLongPress();
}

function triggerHaptic(duration = 10): void {
  if ('vibrate' in navigator) {
    navigator.vibrate(duration);
  }
}

function handleTouchStart(event: TouchEvent): void {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('.touch-key');

  if (button) {
    event.preventDefault();
    button.classList.add('pressing');
    triggerHaptic();

    const key = button.dataset.key;
    const alternates = key ? KEY_ALTERNATES[key] : undefined;
    if (alternates) {
      longPressTimer = window.setTimeout(() => {
        showAlternatesPopup(button, alternates);
        triggerHaptic(20);
      }, LONG_PRESS_DELAY);
    }
  }
}

function handleTouchMove(): void {
  cancelLongPress();
}

function handleTouchEnd(event: TouchEvent): void {
  cancelLongPress();

  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('.touch-key');

  if (button) {
    button.classList.remove('pressing');
  }

  if (alternatesPopup) {
    const altKey = (target as HTMLElement).dataset.key;
    if (altKey) {
      handleKeyPress(altKey);
    }
    removeAlternatesPopup();
    return;
  }

  if (!button) return;

  event.preventDefault();
  processButtonAction(button);
}

function handleClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('.touch-key');

  if (!button) return;

  processButtonAction(button);
}

function processButtonAction(button: HTMLButtonElement): void {
  const modifier = button.dataset.modifier as ModifierKey | undefined;
  const key = button.dataset.key;
  const popup = button.dataset.popup;
  const action = button.dataset.action;

  if (action === 'fullscreen') {
    toggleFullscreen(button);
  } else if (modifier) {
    handleModifierPress(modifier);
  } else if (popup) {
    togglePopup(popup);
  } else if (key) {
    handleKeyPress(key);
  }
}

function handleModifierPress(modifier: ModifierKey): void {
  toggleModifier(modifier);
}

function handleKeyPress(key: string): void {
  const sessionId = $activeSessionId.get();
  if (!sessionId) return;

  const mods = consumeModifiers();
  const sequence = buildKeySequence(key, mods);

  if (sequence) {
    sendInput(sessionId, sequence);
  }
}

function buildKeySequence(
  key: string,
  mods: { ctrl: boolean; alt: boolean; shift: boolean },
): string {
  const baseSequence = KEY_SEQUENCES[key];
  if (!baseSequence) return '';

  if (key.startsWith('ctrl')) {
    return baseSequence;
  }

  if (!mods.ctrl && !mods.alt && !mods.shift) {
    return baseSequence;
  }

  const modCode = getModifierCode(mods);

  if (['up', 'down', 'left', 'right'].includes(key)) {
    const arrows: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D' };
    return '\x1b[1;' + modCode + arrows[key];
  }

  if (key === 'home') return '\x1b[1;' + modCode + 'H';
  if (key === 'end') return '\x1b[1;' + modCode + 'F';

  if (key === 'pgup') return '\x1b[5;' + modCode + '~';
  if (key === 'pgdn') return '\x1b[6;' + modCode + '~';

  if (key === 'tab' && mods.shift) {
    return '\x1b[Z';
  }

  if (mods.ctrl && baseSequence.length === 1) {
    const charCode = baseSequence.charCodeAt(0);
    if (charCode >= 65 && charCode <= 90) {
      return String.fromCharCode(charCode - 64);
    }
    if (charCode >= 97 && charCode <= 122) {
      return String.fromCharCode(charCode - 96);
    }
  }

  return baseSequence;
}

function cancelLongPress(): void {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function showAlternatesPopup(anchor: HTMLElement, alternates: string[]): void {
  removeAlternatesPopup();

  const popup = document.createElement('div');
  popup.className = 'touch-alternates';

  for (const key of alternates) {
    const btn = document.createElement('button');
    btn.className = 'touch-key touch-key-alt';
    btn.dataset.key = key;
    btn.textContent = KEY_LABELS[key] || key;
    popup.appendChild(btn);
  }

  const rect = anchor.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.left = `${rect.left}px`;
  popup.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  popup.style.zIndex = '1000';

  document.body.appendChild(popup);
  alternatesPopup = popup;
}

function removeAlternatesPopup(): void {
  if (alternatesPopup) {
    alternatesPopup.remove();
    alternatesPopup = null;
  }
}

function toggleFullscreen(button: HTMLButtonElement): void {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen().catch(() => {
      // Fullscreen not supported or denied
    });
  }
  syncFullscreenButton(button);
}

function syncFullscreenButton(button?: HTMLButtonElement): void {
  const btn =
    button ?? controllerElement?.querySelector<HTMLButtonElement>('[data-action="fullscreen"]');
  if (!btn) return;
  const isFs = !!document.fullscreenElement;
  btn.classList.toggle('active', isFs);
  btn.setAttribute('aria-pressed', String(isFs));
}

export function initFullscreenSync(): void {
  document.addEventListener('fullscreenchange', () => syncFullscreenButton());
}
