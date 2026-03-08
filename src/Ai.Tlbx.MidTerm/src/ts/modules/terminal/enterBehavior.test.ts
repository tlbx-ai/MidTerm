import { describe, expect, it } from 'vitest';
import { getTerminalEnterOverride, type EnterOverrideInput } from './enterBehavior';

function key(
  value: string,
  mods: Partial<Pick<EnterOverrideInput, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>> = {},
): EnterOverrideInput {
  return {
    key: value,
    ctrlKey: mods.ctrlKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    altKey: mods.altKey ?? false,
    metaKey: mods.metaKey ?? false,
  };
}

describe('getTerminalEnterOverride', () => {
  it('always maps Ctrl+Enter to line feed', () => {
    expect(getTerminalEnterOverride(key('Enter', { ctrlKey: true }), 'default')).toBe('\n');
    expect(getTerminalEnterOverride(key('Enter', { ctrlKey: true }), 'shiftEnterLineFeed')).toBe(
      '\n',
    );
  });

  it('maps Shift+Enter to line feed only when enabled', () => {
    expect(getTerminalEnterOverride(key('Enter', { shiftKey: true }), 'default')).toBeNull();
    expect(
      getTerminalEnterOverride(key('Enter', { shiftKey: true }), 'shiftEnterLineFeed'),
    ).toBe('\n');
  });

  it('leaves Alt+Enter and plain Enter on the xterm default path', () => {
    expect(getTerminalEnterOverride(key('Enter'), 'shiftEnterLineFeed')).toBeNull();
    expect(getTerminalEnterOverride(key('Enter', { altKey: true }), 'shiftEnterLineFeed')).toBeNull();
  });
});
