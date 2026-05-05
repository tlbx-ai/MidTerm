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

  return `bytes=${JSON.stringify(value)}`;
}

export function shouldPasteTerminalEnterOverride(
  target: TerminalEnterTarget,
  value: string,
): boolean {
  return target === 'codex' && value === LINE_FEED;
}

export function describeTerminalEnterOverrideDelivery(
  target: TerminalEnterTarget,
  value: string,
): string {
  const description = describeTerminalEnterOverrideBytes(value);
  return shouldPasteTerminalEnterOverride(target, value)
    ? `xterm-paste ${description}`
    : description;
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
 *
 * Codex line breaks are delivered through xterm's paste/input pipeline in
 * manager.ts, so LF here represents the intended text payload rather than a
 * direct Windows console key-event encoding.
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
      return LINE_FEED;
    }

    return META_ENTER;
  }

  return null;
}
