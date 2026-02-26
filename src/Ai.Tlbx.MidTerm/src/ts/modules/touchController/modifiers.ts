/**
 * Sticky Modifier State Machine
 *
 * Manages one-shot sticky modifiers (Ctrl, Alt, Shift).
 * When activated, combines with next key press then deactivates.
 */

import { CSS_CLASSES } from './constants';

export type ModifierKey = 'ctrl' | 'alt' | 'shift';

export interface ModifierState {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const modifierState: ModifierState = {
  ctrl: false,
  alt: false,
  shift: false,
};

const modifierElements: Map<ModifierKey, HTMLButtonElement> = new Map();

/**
 * Initialize modifier button references
 */
export function initModifiers(container: HTMLElement): void {
  const buttons = container.querySelectorAll<HTMLButtonElement>('[data-modifier]');
  buttons.forEach((btn) => {
    const mod = btn.dataset.modifier;
    if (mod) {
      modifierElements.set(mod as ModifierKey, btn);
    }
  });
}

/**
 * Toggle a modifier's active state
 */
export function toggleModifier(modifier: ModifierKey): void {
  modifierState[modifier] = !modifierState[modifier];
  updateModifierVisual(modifier);
}

/**
 * Get current active modifiers and clear them (one-shot behavior)
 */
export function consumeModifiers(): ModifierState {
  const current = { ...modifierState };

  if (modifierState.ctrl || modifierState.alt || modifierState.shift) {
    modifierState.ctrl = false;
    modifierState.alt = false;
    modifierState.shift = false;
    updateAllVisuals();
  }

  return current;
}

/**
 * Check if any modifier is active
 */
export function hasActiveModifiers(): boolean {
  return modifierState.ctrl || modifierState.alt || modifierState.shift;
}

/**
 * Get modifier code for escape sequence calculation.
 * Code = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0)
 */
export function getModifierCode(mods: ModifierState): number {
  let code = 1;
  if (mods.shift) code += 1;
  if (mods.alt) code += 2;
  if (mods.ctrl) code += 4;
  return code;
}

/**
 * Clear all modifiers without consuming
 */
export function clearModifiers(): void {
  modifierState.ctrl = false;
  modifierState.alt = false;
  modifierState.shift = false;
  updateAllVisuals();
}

function updateModifierVisual(modifier: ModifierKey): void {
  const btn = modifierElements.get(modifier);
  if (btn) {
    btn.classList.toggle(CSS_CLASSES.active, modifierState[modifier]);
    btn.setAttribute('aria-pressed', String(modifierState[modifier]));
  }
}

function updateAllVisuals(): void {
  (['ctrl', 'alt', 'shift'] as ModifierKey[]).forEach(updateModifierVisual);
}
