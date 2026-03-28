import type { EnterOverrideInput } from './enterBehavior';

export interface EnterModifierLatchState {
  ctrlPressed: boolean;
  shiftPressed: boolean;
  lastUpdatedAtMs: number;
}

type EnterModifierKey = 'ctrl' | 'shift';

export interface EnterModifierLatchInput extends Pick<
  EnterOverrideInput,
  'key' | 'code' | 'ctrlKey' | 'shiftKey'
> {
  type: 'keydown' | 'keyup';
}

function getEnterModifierKey(input: EnterModifierLatchInput): EnterModifierKey | null {
  const key = input.key?.toLowerCase();

  if (key === 'control' || input.code === 'ControlLeft' || input.code === 'ControlRight') {
    return 'ctrl';
  }

  if (key === 'shift' || input.code === 'ShiftLeft' || input.code === 'ShiftRight') {
    return 'shift';
  }

  return null;
}

export function updateEnterModifierLatch(
  current: EnterModifierLatchState | null | undefined,
  input: EnterModifierLatchInput,
  nowMs: number,
): EnterModifierLatchState | null {
  const modifier = getEnterModifierKey(input);
  if (!modifier) {
    return current ?? null;
  }

  const next: EnterModifierLatchState = {
    ctrlPressed: current?.ctrlPressed ?? false,
    shiftPressed: current?.shiftPressed ?? false,
    lastUpdatedAtMs: nowMs,
  };
  const isPressed = input.type === 'keydown';

  if (modifier === 'ctrl') {
    next.ctrlPressed = isPressed;
    next.shiftPressed = input.shiftKey || current?.shiftPressed || false;
  } else {
    next.shiftPressed = isPressed;
    next.ctrlPressed = input.ctrlKey || current?.ctrlPressed || false;
  }

  if (!next.ctrlPressed && !next.shiftPressed) {
    return null;
  }

  return next;
}

export function applyEnterModifierLatch(
  input: EnterOverrideInput,
  latch: EnterModifierLatchState | null | undefined,
  nowMs: number,
  maxAgeMs: number,
): EnterOverrideInput {
  if (!latch || nowMs - latch.lastUpdatedAtMs > maxAgeMs) {
    return input;
  }

  const effective: EnterOverrideInput = {
    ctrlKey: input.ctrlKey || latch.ctrlPressed,
    shiftKey: input.shiftKey || latch.shiftPressed,
    altKey: input.altKey,
    metaKey: input.metaKey,
  };

  if (input.key !== undefined) {
    effective.key = input.key;
  }
  if (input.code !== undefined) {
    effective.code = input.code;
  }
  if (input.keyCode !== undefined) {
    effective.keyCode = input.keyCode;
  }
  if (input.which !== undefined) {
    effective.which = input.which;
  }
  if (input.charCode !== undefined) {
    effective.charCode = input.charCode;
  }

  return effective;
}
