/**
 * Terminal Enter Behavior
 *
 * Computes MidTerm-specific Enter key overrides before xterm.js applies its
 * default keyboard translation.
 */

// Keep the legacy persisted values for compatibility with existing settings.json
// files, but treat them as a simple off/on remap toggle in the terminal UI.
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

const META_ENTER = '\x1b\r';

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

export function isTerminalEnterRemapEnabled(mode: TerminalEnterMode): boolean {
  return mode === 'shiftEnterLineFeed';
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
  _target: TerminalEnterTarget = 'default',
): string | null {
  if (!isEnterKey(input)) {
    return null;
  }

  if (
    isTerminalEnterRemapEnabled(mode) &&
    !input.altKey &&
    !input.metaKey &&
    (input.ctrlKey || input.shiftKey)
  ) {
    return META_ENTER;
  }

  return null;
}
