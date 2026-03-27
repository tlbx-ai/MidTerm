import { describe, expect, it } from 'vitest';
import type { EnterOverrideInput } from './enterBehavior';
import { applyEnterModifierLatch, updateEnterModifierLatch } from './enterModifierLatch';

function key(
  value: string | undefined,
  mods: Partial<Pick<EnterOverrideInput, 'ctrlKey' | 'shiftKey'>> = {},
  extra: Partial<Pick<EnterOverrideInput, 'code'>> = {},
): EnterOverrideInput {
  return {
    key: value,
    code: extra.code,
    ctrlKey: mods.ctrlKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    altKey: false,
    metaKey: false,
  };
}

describe('updateEnterModifierLatch', () => {
  it('tracks Shift keydown and clears on keyup', () => {
    const down = updateEnterModifierLatch(null, { ...key('Shift'), type: 'keydown' }, 100);
    expect(down).toEqual({
      ctrlPressed: false,
      shiftPressed: true,
      lastUpdatedAtMs: 100,
    });

    const up = updateEnterModifierLatch(down, { ...key('Shift'), type: 'keyup' }, 120);
    expect(up).toBeNull();
  });

  it('preserves the other modifier while Ctrl and Shift are both held', () => {
    const shiftDown = updateEnterModifierLatch(null, { ...key('Shift'), type: 'keydown' }, 100);
    const ctrlDown = updateEnterModifierLatch(
      shiftDown,
      { ...key('Control', { shiftKey: true }, { code: 'ControlLeft' }), type: 'keydown' },
      120,
    );

    expect(ctrlDown).toEqual({
      ctrlPressed: true,
      shiftPressed: true,
      lastUpdatedAtMs: 120,
    });

    const shiftUp = updateEnterModifierLatch(
      ctrlDown,
      { ...key('Shift', { ctrlKey: true }), type: 'keyup' },
      140,
    );

    expect(shiftUp).toEqual({
      ctrlPressed: true,
      shiftPressed: false,
      lastUpdatedAtMs: 140,
    });
  });
});

describe('applyEnterModifierLatch', () => {
  it('reapplies latched Shift to a degraded Enter event', () => {
    const effective = applyEnterModifierLatch(
      key('Enter'),
      {
        ctrlPressed: false,
        shiftPressed: true,
        lastUpdatedAtMs: 100,
      },
      150,
      500,
    );

    expect(effective.shiftKey).toBe(true);
    expect(effective.ctrlKey).toBe(false);
  });

  it('reapplies latched Ctrl to a degraded Enter event', () => {
    const effective = applyEnterModifierLatch(
      key('Enter'),
      {
        ctrlPressed: true,
        shiftPressed: false,
        lastUpdatedAtMs: 100,
      },
      150,
      500,
    );

    expect(effective.ctrlKey).toBe(true);
    expect(effective.shiftKey).toBe(false);
  });

  it('ignores stale modifier state', () => {
    const original = key('Enter');
    const effective = applyEnterModifierLatch(
      original,
      {
        ctrlPressed: true,
        shiftPressed: true,
        lastUpdatedAtMs: 100,
      },
      1000,
      500,
    );

    expect(effective).toBe(original);
  });
});
