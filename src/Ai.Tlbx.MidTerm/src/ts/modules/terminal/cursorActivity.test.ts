import { describe, expect, it } from 'vitest';
import { shouldBlinkTerminalCursor } from './cursorActivity';

describe('shouldBlinkTerminalCursor', () => {
  const active = {
    configuredToBlink: true,
    documentVisible: true,
    documentFocused: true,
    terminalInputFocused: true,
  };

  it('allows blinking only for a visible focused terminal input', () => {
    expect(shouldBlinkTerminalCursor(active)).toBe(true);
  });

  it.each([
    ['disabled by the user', { configuredToBlink: false }],
    ['in a hidden document', { documentVisible: false }],
    ['in an unfocused window', { documentFocused: false }],
    ['without terminal input focus', { terminalInputFocused: false }],
  ])('stops blinking when %s', (_description, change) => {
    expect(shouldBlinkTerminalCursor({ ...active, ...change })).toBe(false);
  });
});
