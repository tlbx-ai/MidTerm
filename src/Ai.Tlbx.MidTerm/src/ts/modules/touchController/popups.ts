/**
 * Touch Popups Module
 *
 * Category popups for Fn keys, Symbols, and Ctrl combinations.
 * Renders on-demand and auto-closes on outside tap.
 */

import { $activeSessionId } from '../../stores';
import { sendInput } from '../comms';
import { KEY_SEQUENCES, KEY_LABELS } from './constants';

interface PopupGroup {
  label: string;
  keys: string[];
}

interface PopupDefinition {
  id: string;
  layout: 'grid' | 'grouped';
  cols?: number;
  keys?: string[];
  groups?: PopupGroup[];
}

const POPUPS: Record<string, PopupDefinition> = {
  nav: {
    id: 'nav',
    layout: 'grid',
    cols: 4,
    keys: ['tab', 'esc', 'enter', 'backspace', 'home', 'end', 'pgup', 'pgdn', 'insert', 'delete'],
  },
  fn: {
    id: 'fn',
    layout: 'grid',
    cols: 3,
    keys: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'],
  },
  sym: {
    id: 'sym',
    layout: 'grouped',
    groups: [
      {
        label: 'Brackets',
        keys: ['lbracket', 'rbracket', 'lbrace', 'rbrace', 'lparen', 'rparen', 'langle', 'rangle'],
      },
      { label: 'Pipes', keys: ['pipe', 'backslash', 'slash', 'tilde'] },
      { label: 'Quotes', keys: ['squote', 'dquote', 'backtick'] },
      { label: 'Math', keys: ['plus', 'minus', 'equals', 'asterisk', 'percent', 'caret'] },
      {
        label: 'Other',
        keys: ['at', 'hash', 'dollar', 'ampersand', 'underscore', 'semicolon', 'colon'],
      },
    ],
  },
  ctrl: {
    id: 'ctrl',
    layout: 'grid',
    cols: 3,
    keys: [
      'ctrlc',
      'ctrld',
      'ctrlz',
      'ctrla',
      'ctrle',
      'ctrll',
      'ctrlr',
      'ctrlw',
      'ctrlu',
      'ctrlk',
    ],
  },
};

let activePopup: string | null = null;
let outsideTapHandler: ((e: TouchEvent | MouseEvent) => void) | null = null;

export function initPopups(): void {
  renderAllPopups();
}

export function togglePopup(popupId: string): void {
  if (activePopup === popupId) {
    closePopup();
    return;
  }

  closePopup();
  openPopup(popupId);
}

export function closePopup(): void {
  if (!activePopup) return;

  const popup = document.getElementById(`touch-popup-${activePopup}`);
  const trigger = document.querySelector<HTMLElement>(`[data-popup="${activePopup}"]`);

  if (popup) {
    popup.hidden = true;
  }
  if (trigger) {
    trigger.classList.remove('active');
    trigger.setAttribute('aria-expanded', 'false');
  }

  if (outsideTapHandler) {
    document.removeEventListener('touchstart', outsideTapHandler);
    document.removeEventListener('mousedown', outsideTapHandler);
    outsideTapHandler = null;
  }

  activePopup = null;
}

export function getActivePopup(): string | null {
  return activePopup;
}

function openPopup(popupId: string): void {
  const popup = document.getElementById(`touch-popup-${popupId}`);
  const trigger = document.querySelector<HTMLElement>(`[data-popup="${popupId}"]`);

  if (!popup || !trigger) return;

  activePopup = popupId;
  popup.hidden = false;
  trigger.classList.add('active');
  trigger.setAttribute('aria-expanded', 'true');

  positionPopup(popup, trigger);

  outsideTapHandler = (e: TouchEvent | MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!popup.contains(target) && !trigger.contains(target)) {
      closePopup();
    }
  };

  requestAnimationFrame(() => {
    document.addEventListener('touchstart', outsideTapHandler!, { passive: true });
    document.addEventListener('mousedown', outsideTapHandler!);
  });
}

function positionPopup(popup: HTMLElement, trigger: HTMLElement): void {
  const triggerRect = trigger.getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();

  let left = triggerRect.left + triggerRect.width / 2 - popupRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - popupRect.width - 8));

  popup.style.left = `${left}px`;
}

function renderAllPopups(): void {
  for (const [id, def] of Object.entries(POPUPS)) {
    const popup = document.getElementById(`touch-popup-${id}`);
    if (popup) {
      renderPopup(popup, def);
    }
  }
}

function renderPopup(popup: HTMLElement, def: PopupDefinition): void {
  popup.innerHTML = '';

  if (def.layout === 'grid' && def.keys) {
    popup.className = 'touch-popup touch-popup-grid';
    popup.style.setProperty('--popup-cols', String(def.cols || 3));

    for (const key of def.keys) {
      popup.appendChild(createKeyButton(key));
    }
  } else if (def.layout === 'grouped' && def.groups) {
    popup.className = 'touch-popup touch-popup-grouped';

    for (const group of def.groups) {
      const groupEl = document.createElement('div');
      groupEl.className = 'touch-popup-group';

      const labelEl = document.createElement('div');
      labelEl.className = 'touch-popup-group-label';
      labelEl.textContent = group.label;
      groupEl.appendChild(labelEl);

      const keysRow = document.createElement('div');
      keysRow.className = 'touch-popup-group-keys';

      for (const key of group.keys) {
        keysRow.appendChild(createKeyButton(key));
      }

      groupEl.appendChild(keysRow);
      popup.appendChild(groupEl);
    }
  }
}

function createKeyButton(key: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'touch-key touch-popup-key';
  btn.dataset.key = key;
  btn.textContent = KEY_LABELS[key] || key;
  btn.addEventListener('click', handlePopupKeyClick);
  btn.addEventListener('touchend', handlePopupKeyTouch);
  return btn;
}

function handlePopupKeyClick(e: MouseEvent): void {
  const btn = e.currentTarget as HTMLButtonElement;
  const key = btn.dataset.key;
  if (key) {
    sendKey(key);
    closePopup();
  }
}

function handlePopupKeyTouch(e: TouchEvent): void {
  e.preventDefault();
  const btn = e.currentTarget as HTMLButtonElement;
  const key = btn.dataset.key;
  if (key) {
    sendKey(key);
    closePopup();
  }
}

function sendKey(key: string): void {
  const sessionId = $activeSessionId.get();
  if (!sessionId) return;

  const sequence = KEY_SEQUENCES[key];
  if (sequence) {
    sendInput(sessionId, sequence);
  }
}
