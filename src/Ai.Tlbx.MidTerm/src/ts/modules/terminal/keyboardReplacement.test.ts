import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeKeyboardReplacement,
  getKeyboardReplacementHeight,
  openKeyboardReplacement,
  returnToNativeKeyboard,
} from './keyboardReplacement';

describe('keyboard replacement geometry', () => {
  let nativeVisible = true;
  const blur = vi.fn();
  beforeEach(() => {
    nativeVisible = true;
    vi.stubGlobal('window', {
      visualViewport: { height: 480, width: 390 },
      dispatchEvent: vi.fn(),
    });
    vi.stubGlobal('document', {
      activeElement: { blur },
      body: { classList: { contains: () => nativeVisible, add: vi.fn(), remove: vi.fn() } },
    });
  });
  afterEach(() => {
    closeKeyboardReplacement();
    vi.unstubAllGlobals();
  });

  it('keeps the terminal boundary through native keyboard closing frames', () => {
    openKeyboardReplacement();
    for (const height of [480, 540, 650, 844])
      expect(getKeyboardReplacementHeight(height, 390)).toBe(480);
    expect(blur).toHaveBeenCalled();
    closeKeyboardReplacement();
    expect(getKeyboardReplacementHeight(844, 390)).toBeNull();
  });

  it('keeps that boundary until the returning native keyboard reaches it', () => {
    openKeyboardReplacement();
    returnToNativeKeyboard();
    expect(getKeyboardReplacementHeight(844, 390)).toBe(480);
    expect(getKeyboardReplacementHeight(600, 390)).toBe(480);
    expect(getKeyboardReplacementHeight(480, 390)).toBeNull();
  });

  it('reserves a bounded initial keyboard when opened without a native keyboard', () => {
    nativeVisible = false;
    openKeyboardReplacement();
    expect(getKeyboardReplacementHeight(480, 390)).toBe(264);
  });

  it('releases the old orientation geometry on width changes', () => {
    openKeyboardReplacement();
    expect(getKeyboardReplacementHeight(390, 844)).toBeNull();
  });
});
