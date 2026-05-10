import { describe, expect, it } from 'vitest';

import {
  resolveSmartInputShiftTabAction,
  type SmartInputTextareaShortcutEvent,
} from './smartInputTextareaShortcuts';

function key(
  value: string = 'Tab',
  mods: Partial<
    Pick<SmartInputTextareaShortcutEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>
  > = {},
): SmartInputTextareaShortcutEvent {
  return {
    key: value,
    ctrlKey: mods.ctrlKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    altKey: mods.altKey ?? false,
    metaKey: mods.metaKey ?? false,
  };
}

describe('resolveSmartInputShiftTabAction', () => {
  it('toggles AppServerControl plan mode for bare Shift+Tab in the AppServerControl surface', () => {
    expect(resolveSmartInputShiftTabAction(key('Tab', { shiftKey: true }), 'agent')).toBe(
      'toggle-appServerControl-plan-mode',
    );
  });

  it('forwards bare Shift+Tab to terminal sessions', () => {
    expect(resolveSmartInputShiftTabAction(key('Tab', { shiftKey: true }), 'terminal')).toBe(
      'forward-to-terminal',
    );
  });

  it('does not claim Shift+Tab for files or modified tab chords', () => {
    expect(resolveSmartInputShiftTabAction(key('Tab', { shiftKey: true }), 'files')).toBeNull();
    expect(
      resolveSmartInputShiftTabAction(key('Tab', { shiftKey: true, ctrlKey: true }), 'agent'),
    ).toBeNull();
    expect(
      resolveSmartInputShiftTabAction(key('Tab', { shiftKey: true, altKey: true }), 'terminal'),
    ).toBeNull();
    expect(
      resolveSmartInputShiftTabAction(key('Tab', { shiftKey: true, metaKey: true }), 'agent'),
    ).toBeNull();
    expect(resolveSmartInputShiftTabAction(key('Enter', { shiftKey: true }), 'agent')).toBeNull();
  });
});
