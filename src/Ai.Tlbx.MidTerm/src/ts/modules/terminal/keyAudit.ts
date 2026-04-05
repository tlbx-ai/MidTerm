/**
 * Terminal key auditing helpers.
 *
 * This adapts the relevant xterm keyboard translation logic so MidTerm can
 * intercept keyboard input before xterm sees it and still forward the expected
 * bytes to the PTY.
 */

export type TerminalKeyAuditResultType = 'sendKey' | 'pageUp' | 'pageDown' | 'selectAll';

export interface TerminalKeyAuditResult {
  type: TerminalKeyAuditResultType;
  cancel: boolean;
  key?: string;
}

export interface TerminalKeyAuditInput {
  key: string;
  code: string;
  keyCode: number;
  which: number;
  charCode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const ESC = '\x1b';
const CR = '\r';
const DEL = '\x7f';
const HT = '\t';
const NUL = '\0';
const BS = '\b';
const FS = '\x1c';
const GS = '\x1d';
const US = '\x1f';

const KEYCODE_KEY_MAPPINGS: Record<number, [string, string]> = {
  48: ['0', ')'],
  49: ['1', '!'],
  50: ['2', '@'],
  51: ['3', '#'],
  52: ['4', '$'],
  53: ['5', '%'],
  54: ['6', '^'],
  55: ['7', '&'],
  56: ['8', '*'],
  57: ['9', '('],
  186: [';', ':'],
  187: ['=', '+'],
  188: [',', '<'],
  189: ['-', '_'],
  190: ['.', '>'],
  191: ['/', '?'],
  192: ['`', '~'],
  219: ['[', '{'],
  220: ['\\', '|'],
  221: [']', '}'],
  222: ["'", '"'],
};

function createTerminalKeyAuditResult(): TerminalKeyAuditResult {
  return {
    type: 'sendKey',
    cancel: false,
  };
}

function resolveArrowKey(
  direction: 'A' | 'B' | 'C' | 'D',
  modifiers: number,
  applicationCursorMode: boolean,
  metaKey: boolean,
): string | undefined {
  if (metaKey) {
    return undefined;
  }

  if (modifiers) {
    return `${ESC}[1;${String(modifiers + 1)}${direction}`;
  }

  return applicationCursorMode ? `${ESC}O${direction}` : `${ESC}[${direction}`;
}

function resolveHomeEndKey(
  suffix: 'F' | 'H',
  modifiers: number,
  applicationCursorMode: boolean,
): string {
  if (modifiers) {
    return `${ESC}[1;${String(modifiers + 1)}${suffix}`;
  }

  return applicationCursorMode ? `${ESC}O${suffix}` : `${ESC}[${suffix}`;
}

function resolveFunctionKeySequence(modifiers: number, keyCode: number): string | undefined {
  const baseSequences: Record<number, string> = {
    112: `${ESC}OP`,
    113: `${ESC}OQ`,
    114: `${ESC}OR`,
    115: `${ESC}OS`,
    116: `${ESC}[15~`,
    117: `${ESC}[17~`,
    118: `${ESC}[18~`,
    119: `${ESC}[19~`,
    120: `${ESC}[20~`,
    121: `${ESC}[21~`,
    122: `${ESC}[23~`,
    123: `${ESC}[24~`,
  };
  const modifiedSequences: Record<number, string> = {
    112: `${ESC}[1;${String(modifiers + 1)}P`,
    113: `${ESC}[1;${String(modifiers + 1)}Q`,
    114: `${ESC}[1;${String(modifiers + 1)}R`,
    115: `${ESC}[1;${String(modifiers + 1)}S`,
    116: `${ESC}[15;${String(modifiers + 1)}~`,
    117: `${ESC}[17;${String(modifiers + 1)}~`,
    118: `${ESC}[18;${String(modifiers + 1)}~`,
    119: `${ESC}[19;${String(modifiers + 1)}~`,
    120: `${ESC}[20;${String(modifiers + 1)}~`,
    121: `${ESC}[21;${String(modifiers + 1)}~`,
    122: `${ESC}[23;${String(modifiers + 1)}~`,
    123: `${ESC}[24;${String(modifiers + 1)}~`,
  };

  return modifiers ? modifiedSequences[keyCode] : baseSequences[keyCode];
}

function applyEditingKeyAuditResult(
  result: TerminalKeyAuditResult,
  ev: TerminalKeyAuditInput,
  modifiers: number,
): boolean {
  switch (ev.keyCode) {
    case 8:
      result.key = ev.ctrlKey ? BS : DEL;
      if (ev.altKey) {
        result.key = ESC + result.key;
      }
      return true;
    case 9:
      result.key = ev.shiftKey ? `${ESC}[Z` : HT;
      result.cancel = true;
      return true;
    case 13:
      result.key = ev.altKey ? ESC + CR : CR;
      result.cancel = true;
      return true;
    case 27:
      result.key = ev.altKey ? ESC + ESC : ESC;
      result.cancel = true;
      return true;
    case 45:
      if (!ev.shiftKey && !ev.ctrlKey) {
        result.key = `${ESC}[2~`;
      }
      return true;
    case 46:
      result.key = modifiers ? `${ESC}[3;${String(modifiers + 1)}~` : `${ESC}[3~`;
      return true;
    default:
      return false;
  }
}

function applyCtrlOnlyKeyAuditResult(
  result: TerminalKeyAuditResult,
  ev: TerminalKeyAuditInput,
): boolean {
  if (!ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey) {
    return false;
  }

  if (ev.keyCode >= 65 && ev.keyCode <= 90) {
    result.key = String.fromCharCode(ev.keyCode - 64);
    return true;
  }

  switch (ev.keyCode) {
    case 32:
      result.key = NUL;
      return true;
    case 56:
      result.key = DEL;
      return true;
    case 219:
      result.key = ESC;
      return true;
    case 220:
      result.key = FS;
      return true;
    case 221:
      result.key = GS;
      return true;
    default:
      if (ev.keyCode >= 51 && ev.keyCode <= 55) {
        result.key = String.fromCharCode(ev.keyCode - 51 + 27);
        return true;
      }
      return false;
  }
}

function applyNavigationKeyAuditResult(
  result: TerminalKeyAuditResult,
  ev: TerminalKeyAuditInput,
  modifiers: number,
  applicationCursorMode: boolean,
): boolean {
  switch (ev.keyCode) {
    case 37: {
      const key = resolveArrowKey('D', modifiers, applicationCursorMode, ev.metaKey);
      if (!key) {
        return false;
      }
      result.key = key;
      return true;
    }
    case 38: {
      const key = resolveArrowKey('A', modifiers, applicationCursorMode, ev.metaKey);
      if (!key) {
        return false;
      }
      result.key = key;
      return true;
    }
    case 39: {
      const key = resolveArrowKey('C', modifiers, applicationCursorMode, ev.metaKey);
      if (!key) {
        return false;
      }
      result.key = key;
      return true;
    }
    case 40: {
      const key = resolveArrowKey('B', modifiers, applicationCursorMode, ev.metaKey);
      if (!key) {
        return false;
      }
      result.key = key;
      return true;
    }
    case 33:
      if (ev.shiftKey) {
        result.type = 'pageUp';
      } else {
        result.key = ev.ctrlKey ? `${ESC}[5;${String(modifiers + 1)}~` : `${ESC}[5~`;
      }
      return true;
    case 34:
      if (ev.shiftKey) {
        result.type = 'pageDown';
      } else {
        result.key = ev.ctrlKey ? `${ESC}[6;${String(modifiers + 1)}~` : `${ESC}[6~`;
      }
      return true;
    case 35:
      result.key = resolveHomeEndKey('F', modifiers, applicationCursorMode);
      return true;
    case 36:
      result.key = resolveHomeEndKey('H', modifiers, applicationCursorMode);
      return true;
    default:
      return false;
  }
}

function applyFunctionKeyAuditResult(
  result: TerminalKeyAuditResult,
  ev: TerminalKeyAuditInput,
  modifiers: number,
): boolean {
  const functionKeySequence = resolveFunctionKeySequence(modifiers, ev.keyCode);
  if (!functionKeySequence) {
    return false;
  }

  result.key = functionKeySequence;
  return true;
}

function applyAltKeyAuditResult(
  result: TerminalKeyAuditResult,
  ev: TerminalKeyAuditInput,
  isMac: boolean,
  macOptionIsMeta: boolean,
): boolean {
  if ((isMac && !macOptionIsMeta) || !ev.altKey || ev.metaKey) {
    return false;
  }

  const keyMapping = KEYCODE_KEY_MAPPINGS[ev.keyCode];
  const mappedKey = keyMapping?.[ev.shiftKey ? 1 : 0];
  if (mappedKey) {
    result.key = ESC + mappedKey;
    return true;
  }

  if (ev.keyCode >= 65 && ev.keyCode <= 90) {
    const keyCode = ev.ctrlKey ? ev.keyCode - 64 : ev.keyCode + 32;
    let keyString = String.fromCharCode(keyCode);
    if (ev.shiftKey) {
      keyString = keyString.toUpperCase();
    }
    result.key = ESC + keyString;
    return true;
  }

  if (ev.keyCode === 32) {
    result.key = ESC + (ev.ctrlKey ? NUL : ' ');
    return true;
  }

  if (ev.key === 'Dead' && ev.code.startsWith('Key')) {
    let keyString = ev.code.slice(3, 4);
    if (!ev.shiftKey) {
      keyString = keyString.toLowerCase();
    }
    result.key = ESC + keyString;
    result.cancel = true;
    return true;
  }

  return false;
}

function applyMacMetaKeyAuditResult(
  result: TerminalKeyAuditResult,
  ev: TerminalKeyAuditInput,
  isMac: boolean,
): boolean {
  if (isMac && !ev.altKey && !ev.ctrlKey && !ev.shiftKey && ev.metaKey && ev.keyCode === 65) {
    result.type = 'selectAll';
    return true;
  }

  return false;
}

function applyPrintableKeyAuditResult(
  result: TerminalKeyAuditResult,
  ev: TerminalKeyAuditInput,
): boolean {
  if (
    ev.key &&
    !ev.ctrlKey &&
    !ev.altKey &&
    !ev.metaKey &&
    ev.keyCode >= 48 &&
    ev.key.length === 1
  ) {
    result.key = ev.key;
    return true;
  }

  if (ev.key && ev.ctrlKey) {
    if (ev.key === '_') {
      result.key = US;
      return true;
    }
    if (ev.key === '@') {
      result.key = NUL;
      return true;
    }
  }

  return false;
}

export function evaluateTerminalKeyAudit(
  ev: TerminalKeyAuditInput,
  applicationCursorMode: boolean,
  isMac: boolean,
  macOptionIsMeta: boolean,
): TerminalKeyAuditResult {
  const result = createTerminalKeyAuditResult();
  const modifiers =
    (ev.shiftKey ? 1 : 0) | (ev.altKey ? 2 : 0) | (ev.ctrlKey ? 4 : 0) | (ev.metaKey ? 8 : 0);

  if (
    !applyEditingKeyAuditResult(result, ev, modifiers) &&
    !applyNavigationKeyAuditResult(result, ev, modifiers, applicationCursorMode) &&
    !applyFunctionKeyAuditResult(result, ev, modifiers) &&
    !applyCtrlOnlyKeyAuditResult(result, ev) &&
    !applyAltKeyAuditResult(result, ev, isMac, macOptionIsMeta) &&
    !applyMacMetaKeyAuditResult(result, ev, isMac)
  ) {
    applyPrintableKeyAuditResult(result, ev);
  }

  return result;
}

export function isThirdLevelShift(
  ev: Pick<TerminalKeyAuditInput, 'altKey' | 'ctrlKey' | 'metaKey' | 'keyCode'> & {
    type?: string;
    getModifierState?: (key: string) => boolean;
  },
  isMac: boolean,
  isWindows: boolean,
  macOptionIsMeta: boolean,
): boolean {
  const thirdLevelKey =
    (isMac && !macOptionIsMeta && ev.altKey && !ev.ctrlKey && !ev.metaKey) ||
    (isWindows && ev.altKey && ev.ctrlKey && !ev.metaKey) ||
    (isWindows && ev.getModifierState?.('AltGraph') === true);

  if (ev.type === 'keypress') {
    return thirdLevelKey;
  }

  return thirdLevelKey && (!ev.keyCode || ev.keyCode > 47);
}

export function isModifierKeyOnlyEvent(ev: Pick<TerminalKeyAuditInput, 'key'>): boolean {
  return ev.key === 'Shift' || ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Meta';
}
