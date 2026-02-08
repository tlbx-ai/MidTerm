/**
 * Clipboard Shortcut Resolver
 *
 * Resolves copy/paste keyboard shortcuts for terminal input handling.
 */

/**
 * Minimal keyboard event shape needed for shortcut resolution.
 */
export interface ShortcutInput {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * Resolve whether the event is a copy shortcut for the current style.
 */
export function isCopyShortcut(input: ShortcutInput, style: 'windows' | 'unix'): boolean {
  const key = input.key.toLowerCase();
  if (key !== 'c') return false;

  if (style === 'windows') {
    return input.ctrlKey && !input.shiftKey && !input.altKey && !input.metaKey;
  }

  return input.ctrlKey && input.shiftKey && !input.altKey && !input.metaKey;
}

/**
 * Resolve whether the event should trigger clipboard paste handling.
 *
 * Unified aliases:
 * - Ctrl+V
 * - Cmd+V
 * - Ctrl+Shift+V
 * - Alt+V
 */
export function isPasteShortcut(input: ShortcutInput): boolean {
  const key = input.key.toLowerCase();
  if (key !== 'v') return false;

  // Alt+V
  if (input.altKey && !input.ctrlKey && !input.shiftKey && !input.metaKey) {
    return true;
  }

  // Cmd+V
  if (input.metaKey && !input.ctrlKey && !input.shiftKey && !input.altKey) {
    return true;
  }

  // Ctrl+V and Ctrl+Shift+V
  if (input.ctrlKey && !input.metaKey && !input.altKey) {
    return true;
  }

  return false;
}
