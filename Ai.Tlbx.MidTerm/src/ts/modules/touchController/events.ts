/**
 * Touch Event Handlers
 *
 * Manages touch interactions for the controller bar.
 */

import { activeSessionId } from '../../state';
import { sendInput } from '../comms/muxChannel';
import { KEY_SEQUENCES, SELECTORS, CSS_CLASSES } from './constants';
import { toggleModifier, consumeModifiers, getModifierCode, type ModifierKey } from './modifiers';

let controllerElement: HTMLElement | null = null;
let panelElement: HTMLElement | null = null;
let expandButton: HTMLButtonElement | null = null;

/**
 * Initialize event handlers for touch controller
 */
export function initEvents(container: HTMLElement): void {
  controllerElement = container;
  panelElement = container.querySelector<HTMLElement>(SELECTORS.panel);
  expandButton = container.querySelector<HTMLButtonElement>(SELECTORS.expandButton);

  container.addEventListener('touchstart', preventDefaults, { passive: false });
  container.addEventListener('touchend', handleTouchEnd, { passive: false });
  container.addEventListener('click', handleClick);
}

/**
 * Clean up event handlers
 */
export function teardownEvents(): void {
  if (controllerElement) {
    controllerElement.removeEventListener('touchstart', preventDefaults);
    controllerElement.removeEventListener('touchend', handleTouchEnd);
    controllerElement.removeEventListener('click', handleClick);
  }
  controllerElement = null;
  panelElement = null;
  expandButton = null;
}

function preventDefaults(event: TouchEvent): void {
  const target = event.target as HTMLElement;
  if (target.closest('.touch-key')) {
    event.preventDefault();
  }
}

function handleTouchEnd(event: TouchEvent): void {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('.touch-key');

  if (!button) return;

  event.preventDefault();

  const modifier = button.dataset.modifier as ModifierKey | undefined;
  const key = button.dataset.key;
  const action = button.dataset.action;

  if (modifier) {
    handleModifierPress(modifier);
  } else if (action === 'expand') {
    handleExpandToggle();
  } else if (key) {
    handleKeyPress(key);
  }
}

function handleClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('.touch-key');

  if (!button) return;

  const modifier = button.dataset.modifier as ModifierKey | undefined;
  const key = button.dataset.key;
  const action = button.dataset.action;

  if (modifier) {
    handleModifierPress(modifier);
  } else if (action === 'expand') {
    handleExpandToggle();
  } else if (key) {
    handleKeyPress(key);
  }
}

function handleModifierPress(modifier: ModifierKey): void {
  toggleModifier(modifier);
}

function handleExpandToggle(): void {
  if (!panelElement || !expandButton || !controllerElement) return;

  const isExpanded = panelElement.classList.toggle(CSS_CLASSES.expanded);
  panelElement.setAttribute('aria-hidden', String(!isExpanded));
  expandButton.setAttribute('aria-expanded', String(isExpanded));
  document.body.classList.toggle(CSS_CLASSES.panelExpanded, isExpanded);

  requestAnimationFrame(() => {
    const terminalsArea = document.querySelector<HTMLElement>('.terminals-area');
    if (terminalsArea && controllerElement) {
      terminalsArea.style.paddingBottom = controllerElement.offsetHeight + 'px';
    }
  });
}

function handleKeyPress(key: string): void {
  const sessionId = activeSessionId;
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
