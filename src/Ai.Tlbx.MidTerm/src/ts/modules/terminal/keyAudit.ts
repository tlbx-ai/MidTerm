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

export function evaluateTerminalKeyAudit(
  ev: TerminalKeyAuditInput,
  applicationCursorMode: boolean,
  isMac: boolean,
  macOptionIsMeta: boolean,
): TerminalKeyAuditResult {
  const result: TerminalKeyAuditResult = {
    type: 'sendKey',
    cancel: false,
  };
  const modifiers =
    (ev.shiftKey ? 1 : 0) | (ev.altKey ? 2 : 0) | (ev.ctrlKey ? 4 : 0) | (ev.metaKey ? 8 : 0);

  switch (ev.keyCode) {
    case 8:
      result.key = ev.ctrlKey ? BS : DEL;
      if (ev.altKey) {
        result.key = ESC + result.key;
      }
      break;
    case 9:
      if (ev.shiftKey) {
        result.key = ESC + '[Z';
        break;
      }
      result.key = HT;
      result.cancel = true;
      break;
    case 13:
      result.key = ev.altKey ? ESC + CR : CR;
      result.cancel = true;
      break;
    case 27:
      result.key = ev.altKey ? ESC + ESC : ESC;
      result.cancel = true;
      break;
    case 37:
      if (ev.metaKey) {
        break;
      }
      if (modifiers) {
        result.key = `${ESC}[1;${String(modifiers + 1)}D`;
      } else if (applicationCursorMode) {
        result.key = ESC + 'OD';
      } else {
        result.key = ESC + '[D';
      }
      break;
    case 38:
      if (ev.metaKey) {
        break;
      }
      if (modifiers) {
        result.key = `${ESC}[1;${String(modifiers + 1)}A`;
      } else if (applicationCursorMode) {
        result.key = ESC + 'OA';
      } else {
        result.key = ESC + '[A';
      }
      break;
    case 39:
      if (ev.metaKey) {
        break;
      }
      if (modifiers) {
        result.key = `${ESC}[1;${String(modifiers + 1)}C`;
      } else if (applicationCursorMode) {
        result.key = ESC + 'OC';
      } else {
        result.key = ESC + '[C';
      }
      break;
    case 40:
      if (ev.metaKey) {
        break;
      }
      if (modifiers) {
        result.key = `${ESC}[1;${String(modifiers + 1)}B`;
      } else if (applicationCursorMode) {
        result.key = ESC + 'OB';
      } else {
        result.key = ESC + '[B';
      }
      break;
    case 45:
      if (!ev.shiftKey && !ev.ctrlKey) {
        result.key = ESC + '[2~';
      }
      break;
    case 46:
      result.key = modifiers ? `${ESC}[3;${String(modifiers + 1)}~` : ESC + '[3~';
      break;
    case 33:
      if (ev.shiftKey) {
        result.type = 'pageUp';
      } else if (ev.ctrlKey) {
        result.key = `${ESC}[5;${String(modifiers + 1)}~`;
      } else {
        result.key = ESC + '[5~';
      }
      break;
    case 34:
      if (ev.shiftKey) {
        result.type = 'pageDown';
      } else if (ev.ctrlKey) {
        result.key = `${ESC}[6;${String(modifiers + 1)}~`;
      } else {
        result.key = ESC + '[6~';
      }
      break;
    case 35:
      result.key = modifiers
        ? `${ESC}[1;${String(modifiers + 1)}F`
        : applicationCursorMode
          ? ESC + 'OF'
          : ESC + '[F';
      break;
    case 36:
      result.key = modifiers
        ? `${ESC}[1;${String(modifiers + 1)}H`
        : applicationCursorMode
          ? ESC + 'OH'
          : ESC + '[H';
      break;
    case 112:
      result.key = modifiers ? `${ESC}[1;${String(modifiers + 1)}P` : ESC + 'OP';
      break;
    case 113:
      result.key = modifiers ? `${ESC}[1;${String(modifiers + 1)}Q` : ESC + 'OQ';
      break;
    case 114:
      result.key = modifiers ? `${ESC}[1;${String(modifiers + 1)}R` : ESC + 'OR';
      break;
    case 115:
      result.key = modifiers ? `${ESC}[1;${String(modifiers + 1)}S` : ESC + 'OS';
      break;
    case 116:
      result.key = modifiers ? `${ESC}[15;${String(modifiers + 1)}~` : ESC + '[15~';
      break;
    case 117:
      result.key = modifiers ? `${ESC}[17;${String(modifiers + 1)}~` : ESC + '[17~';
      break;
    case 118:
      result.key = modifiers ? `${ESC}[18;${String(modifiers + 1)}~` : ESC + '[18~';
      break;
    case 119:
      result.key = modifiers ? `${ESC}[19;${String(modifiers + 1)}~` : ESC + '[19~';
      break;
    case 120:
      result.key = modifiers ? `${ESC}[20;${String(modifiers + 1)}~` : ESC + '[20~';
      break;
    case 121:
      result.key = modifiers ? `${ESC}[21;${String(modifiers + 1)}~` : ESC + '[21~';
      break;
    case 122:
      result.key = modifiers ? `${ESC}[23;${String(modifiers + 1)}~` : ESC + '[23~';
      break;
    case 123:
      result.key = modifiers ? `${ESC}[24;${String(modifiers + 1)}~` : ESC + '[24~';
      break;
    default:
      if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey) {
        if (ev.keyCode >= 65 && ev.keyCode <= 90) {
          result.key = String.fromCharCode(ev.keyCode - 64);
        } else if (ev.keyCode === 32) {
          result.key = NUL;
        } else if (ev.keyCode >= 51 && ev.keyCode <= 55) {
          result.key = String.fromCharCode(ev.keyCode - 51 + 27);
        } else if (ev.keyCode === 56) {
          result.key = DEL;
        } else if (ev.keyCode === 219) {
          result.key = ESC;
        } else if (ev.keyCode === 220) {
          result.key = FS;
        } else if (ev.keyCode === 221) {
          result.key = GS;
        }
      } else if ((!isMac || macOptionIsMeta) && ev.altKey && !ev.metaKey) {
        const keyMapping = KEYCODE_KEY_MAPPINGS[ev.keyCode];
        const mappedKey = keyMapping?.[ev.shiftKey ? 1 : 0];
        if (mappedKey) {
          result.key = ESC + mappedKey;
        } else if (ev.keyCode >= 65 && ev.keyCode <= 90) {
          const keyCode = ev.ctrlKey ? ev.keyCode - 64 : ev.keyCode + 32;
          let keyString = String.fromCharCode(keyCode);
          if (ev.shiftKey) {
            keyString = keyString.toUpperCase();
          }
          result.key = ESC + keyString;
        } else if (ev.keyCode === 32) {
          result.key = ESC + (ev.ctrlKey ? NUL : ' ');
        } else if (ev.key === 'Dead' && ev.code.startsWith('Key')) {
          let keyString = ev.code.slice(3, 4);
          if (!ev.shiftKey) {
            keyString = keyString.toLowerCase();
          }
          result.key = ESC + keyString;
          result.cancel = true;
        }
      } else if (isMac && !ev.altKey && !ev.ctrlKey && !ev.shiftKey && ev.metaKey) {
        if (ev.keyCode === 65) {
          result.type = 'selectAll';
        }
      } else if (
        ev.key &&
        !ev.ctrlKey &&
        !ev.altKey &&
        !ev.metaKey &&
        ev.keyCode >= 48 &&
        ev.key.length === 1
      ) {
        result.key = ev.key;
      } else if (ev.key && ev.ctrlKey) {
        if (ev.key === '_') {
          result.key = US;
        }
        if (ev.key === '@') {
          result.key = NUL;
        }
      }
      break;
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
