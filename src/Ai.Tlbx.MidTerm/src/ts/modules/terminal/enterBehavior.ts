/**
 * Terminal Enter Behavior
 *
 * Computes MidTerm-specific Enter key overrides before xterm.js applies its
 * default keyboard translation.
 */

// Keep the legacy persisted values for compatibility with existing settings.json
// files, but treat them as a simple off/on remap toggle in the terminal UI.
export type TerminalEnterMode = 'default' | 'shiftEnterLineFeed';
export type TerminalEnterTarget = 'default' | 'powershell' | 'codex';

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
const LINE_FEED = '\n';
const CODEX_ENTER_KEY_CODE = 13;
const KITTY_KEY_PRESS_EVENT_TYPE = 1;

function containsCodexToken(value: string): boolean {
  return /(^|[\\/\s"'])codex(?:\.cmd|\.exe|\.js)?(?:$|[\s"'./\\-])/.test(value);
}

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

export function isCodexEnterTarget(
  foregroundName?: string | null,
  foregroundCommandLine?: string | null,
  shellType?: string | null,
): boolean {
  const haystack =
    `${foregroundName ?? ''} ${foregroundCommandLine ?? ''} ${shellType ?? ''}`.toLowerCase();

  return haystack.includes('@openai/codex') || containsCodexToken(haystack);
}

export function getTerminalEnterTarget(
  foregroundName?: string | null,
  foregroundCommandLine?: string | null,
  shellType?: string | null,
): TerminalEnterTarget {
  if (isCodexEnterTarget(foregroundName, foregroundCommandLine, shellType)) {
    return 'codex';
  }

  return isPowerShellEnterTarget(foregroundName, foregroundCommandLine, shellType)
    ? 'powershell'
    : 'default';
}

export function isTerminalEnterRemapEnabled(mode: TerminalEnterMode): boolean {
  return mode === 'shiftEnterLineFeed';
}

export function describeTerminalEnterOverrideBytes(value: string): string {
  if (value === META_ENTER) {
    return 'ESC+CR';
  }
  if (value === LINE_FEED) {
    return 'LF';
  }
  if (value.startsWith('\x1b[13;') && value.endsWith(':1u')) {
    const modifierMask = value.slice('\x1b[13;'.length, -':1u'.length);
    return `CSI-u Enter mask=${modifierMask} press`;
  }

  return `bytes=${JSON.stringify(value)}`;
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

function getKittyModifierMask(input: EnterOverrideInput): number {
  let modifierBits = 0;
  if (input.shiftKey) {
    modifierBits |= 1;
  }
  if (input.altKey) {
    modifierBits |= 2;
  }
  if (input.ctrlKey) {
    modifierBits |= 4;
  }

  return modifierBits + 1;
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

  if (
    isTerminalEnterRemapEnabled(mode) &&
    (target === 'codex' || !input.altKey) &&
    !input.metaKey &&
    (input.ctrlKey || input.shiftKey || (target === 'codex' && input.altKey))
  ) {
    if (target === 'codex') {
      return `\x1b[${CODEX_ENTER_KEY_CODE};${getKittyModifierMask(
        input,
      )}:${KITTY_KEY_PRESS_EVENT_TYPE}u`;
    }

    return META_ENTER;
  }

  return null;
}
