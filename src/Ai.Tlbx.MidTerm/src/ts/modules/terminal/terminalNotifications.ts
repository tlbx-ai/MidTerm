import type { IDisposable, Terminal } from '@xterm/xterm';

export type TerminalNotificationProtocol = 'bel' | 'osc9' | 'osc777' | 'cli';

export interface TerminalNotificationSignal {
  protocol: TerminalNotificationProtocol;
  title?: string;
  body?: string;
  force?: boolean;
  priority?: 'normal' | 'important';
  nativeHandled?: boolean;
}

export interface DesktopNotificationVisibility {
  documentHidden: boolean;
  documentFocused: boolean;
  sourceSessionActive: boolean;
}

const MAX_NOTIFICATION_TITLE_GRAPHEMES = 80;
const MAX_NOTIFICATION_BODY_GRAPHEMES = 240;
function isControlOrBidiCharacter(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function stripTerminalEscapeSequences(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) !== 0x1b) {
      result += value.charAt(index);
      continue;
    }

    const introducer = value[index + 1];
    if (introducer === '[') {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) break;
        index++;
      }
    } else if (introducer === ']') {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code === 0x07) break;
        if (code === 0x1b && value[index + 1] === '\\') {
          index++;
          break;
        }
        index++;
      }
    } else {
      index++;
    }
  }
  return result;
}

function truncateCodePoints(value: string, limit: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= limit) return value;
  return `${codePoints.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

export function normalizeTerminalNotificationText(value: string, limit: number): string | null {
  const normalized = Array.from(stripTerminalEscapeSequences(value), (character) =>
    isControlOrBidiCharacter(character.codePointAt(0) ?? 0) ? ' ' : character,
  )
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? truncateCodePoints(normalized, limit) : null;
}

/**
 * OSC 9 is used by Codex and several terminals for a plain desktop notification.
 * Numeric subcommands belong to terminal-specific control extensions (notably
 * OSC 9;4 progress reporting) and must not become user-visible notifications.
 */
export function parseOsc9Notification(payload: string): TerminalNotificationSignal | null {
  const body = normalizeTerminalNotificationText(payload, MAX_NOTIFICATION_BODY_GRAPHEMES);
  if (!body || /^\d+;/.test(body)) return null;
  return { protocol: 'osc9', body };
}

/** Parse the widely supported rxvt/Warp form: OSC 777;notify;title;body ST. */
export function parseOsc777Notification(payload: string): TerminalNotificationSignal | null {
  if (!payload.startsWith('notify;')) return null;

  const titleSeparator = payload.indexOf(';', 'notify;'.length);
  if (titleSeparator < 0) return null;

  const title = normalizeTerminalNotificationText(
    payload.slice('notify;'.length, titleSeparator),
    MAX_NOTIFICATION_TITLE_GRAPHEMES,
  );
  const body = normalizeTerminalNotificationText(
    payload.slice(titleSeparator + 1),
    MAX_NOTIFICATION_BODY_GRAPHEMES,
  );
  if (!title && !body) return null;

  return {
    protocol: 'osc777',
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
  };
}

export function registerTerminalNotificationHandlers(
  terminal: Terminal,
  notify: (signal: TerminalNotificationSignal) => void,
): IDisposable[] {
  return [
    terminal.onBell(() => {
      notify({ protocol: 'bel' });
    }),
    terminal.parser.registerOscHandler(9, (payload: string) => {
      const signal = parseOsc9Notification(payload);
      if (signal) notify(signal);
      return true;
    }),
    terminal.parser.registerOscHandler(777, (payload: string) => {
      const signal = parseOsc777Notification(payload);
      if (signal) notify(signal);
      return true;
    }),
  ];
}

export function shouldShowDesktopTerminalNotification(
  visibility: DesktopNotificationVisibility,
  force = false,
): boolean {
  if (force) return true;
  return (
    visibility.documentHidden || !visibility.documentFocused || !visibility.sourceSessionActive
  );
}

export function buildTerminalNotificationBody(signal: TerminalNotificationSignal): string {
  if (signal.title && signal.body) return `${signal.title}: ${signal.body}`;
  return signal.body ?? signal.title ?? 'Needs your attention';
}
