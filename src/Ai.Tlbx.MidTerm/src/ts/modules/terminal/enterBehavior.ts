/**
 * Terminal Enter Behavior
 *
 * Computes MidTerm-specific Enter key overrides before xterm.js applies its
 * default keyboard translation.
 */

export type TerminalEnterMode = 'default' | 'shiftEnterLineFeed';
export type TerminalEnterTarget = 'default' | 'powershell';

export interface EnterOverrideInput {
  key?: string;
  code?: string;
  keyCode?: number;
  which?: number;
  charCode?: number;
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
  shellType?: string | null,
): boolean {
  const haystack =
    `${foregroundName ?? ''} ${foregroundCommandLine ?? ''} ${shellType ?? ''}`.toLowerCase();
  return (
    haystack.includes('pwsh') || haystack.includes('powershell') || haystack.includes('psreadline')
  );
}

function isEnterKey(input: EnterOverrideInput): boolean {
  return (
    input.key === 'Enter' ||
    input.code === 'Enter' ||
    input.code === 'NumpadEnter' ||
    input.keyCode === 13 ||
    input.which === 13 ||
    input.charCode === 13
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
  if (!isEnterKey(input)) {
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
