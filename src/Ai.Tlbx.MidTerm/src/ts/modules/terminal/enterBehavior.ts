/**
 * Terminal Enter Behavior
 *
 * Computes MidTerm-specific Enter key overrides before xterm.js applies its
 * default keyboard translation.
 */

export type TerminalEnterMode = 'default' | 'shiftEnterLineFeed';
export type TerminalEnterTarget = 'default' | 'powershell';

export interface EnterOverrideInput {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const PSREADLINE_SHIFT_ENTER = '\x1b[13;2u';
const PSREADLINE_CTRL_ENTER = '\x1b[13;5u';
const PSREADLINE_CTRL_SHIFT_ENTER = '\x1b[13;6u';

export function isPowerShellEnterTarget(
  foregroundName?: string | null,
  foregroundCommandLine?: string | null,
): boolean {
  const haystack = `${foregroundName ?? ''} ${foregroundCommandLine ?? ''}`.toLowerCase();
  return (
    haystack.includes('pwsh') || haystack.includes('powershell') || haystack.includes('psreadline')
  );
}

/**
 * Returns the raw terminal bytes to send when MidTerm overrides Enter.
 */
export function getTerminalEnterOverride(
  input: EnterOverrideInput,
  mode: TerminalEnterMode,
  target: TerminalEnterTarget = 'default',
): string | null {
  if (input.key !== 'Enter') {
    return null;
  }

  if (!input.altKey && !input.metaKey && target === 'powershell') {
    if (input.ctrlKey && input.shiftKey) {
      return PSREADLINE_CTRL_SHIFT_ENTER;
    }

    if (input.ctrlKey) {
      return PSREADLINE_CTRL_ENTER;
    }

    if (mode === 'shiftEnterLineFeed' && input.shiftKey) {
      return PSREADLINE_SHIFT_ENTER;
    }
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
