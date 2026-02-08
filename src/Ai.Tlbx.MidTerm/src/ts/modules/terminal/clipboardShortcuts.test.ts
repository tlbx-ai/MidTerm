import { describe, expect, it } from 'vitest';
import { isCopyShortcut, isPasteShortcut, type ShortcutInput } from './clipboardShortcuts';

function key(
  value: string,
  mods: Partial<Pick<ShortcutInput, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>> = {},
): ShortcutInput {
  return {
    key: value,
    ctrlKey: mods.ctrlKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    altKey: mods.altKey ?? false,
    metaKey: mods.metaKey ?? false,
  };
}

describe('isPasteShortcut', () => {
  it('matches unified aliases', () => {
    expect(isPasteShortcut(key('v', { ctrlKey: true }))).toBe(true);
    expect(isPasteShortcut(key('V', { ctrlKey: true }))).toBe(true);
    expect(isPasteShortcut(key('v', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isPasteShortcut(key('v', { metaKey: true }))).toBe(true);
    expect(isPasteShortcut(key('v', { altKey: true }))).toBe(true);
  });

  it('rejects unrelated or ambiguous combinations', () => {
    expect(isPasteShortcut(key('v'))).toBe(false);
    expect(isPasteShortcut(key('x', { ctrlKey: true }))).toBe(false);
    expect(isPasteShortcut(key('v', { altKey: true, shiftKey: true }))).toBe(false);
    expect(isPasteShortcut(key('v', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPasteShortcut(key('v', { metaKey: true, shiftKey: true }))).toBe(false);
  });
});

describe('isCopyShortcut', () => {
  it('matches windows copy shortcuts only', () => {
    expect(isCopyShortcut(key('c', { ctrlKey: true }), 'windows')).toBe(true);
    expect(isCopyShortcut(key('c', { ctrlKey: true, shiftKey: true }), 'windows')).toBe(false);
  });

  it('matches unix copy shortcuts only', () => {
    expect(isCopyShortcut(key('c', { ctrlKey: true, shiftKey: true }), 'unix')).toBe(true);
    expect(isCopyShortcut(key('c', { ctrlKey: true }), 'unix')).toBe(false);
  });
});
