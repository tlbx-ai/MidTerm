/**
 * Terminal Enter Behavior
 *
 * Computes MidTerm-specific Enter key overrides before xterm.js applies its
 * default keyboard translation.
 */

export type TerminalEnterMode = 'default' | 'shiftEnterLineFeed';

export interface EnterOverrideInput {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * Returns the raw terminal bytes to send when MidTerm overrides Enter.
 */
export function getTerminalEnterOverride(
  input: EnterOverrideInput,
  mode: TerminalEnterMode,
): string | null {
  if (input.key !== 'Enter') {
    return null;
  }

  if (input.ctrlKey && !input.shiftKey && !input.altKey && !input.metaKey) {
    return '\n';
  }

  if (
    mode === 'shiftEnterLineFeed' &&
    input.shiftKey &&
    !input.ctrlKey &&
    !input.altKey &&
    !input.metaKey
  ) {
    return '\n';
  }

  return null;
}
