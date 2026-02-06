/**
 * Touch Controller Constants
 *
 * Escape sequences and key mappings for terminal input.
 */

/** ANSI escape sequences for special keys */
export const KEY_SEQUENCES: Record<string, string> = {
  // Arrow keys
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',

  // Navigation
  home: '\x1b[H',
  end: '\x1b[F',
  pgup: '\x1b[5~',
  pgdn: '\x1b[6~',
  insert: '\x1b[2~',
  delete: '\x1b[3~',

  // Control characters
  tab: '\t',
  enter: '\r',
  esc: '\x1b',
  backspace: '\x7f',

  // Ctrl combinations (sent directly)
  ctrlc: '\x03',
  ctrld: '\x04',
  ctrlz: '\x1a',
  ctrla: '\x01',
  ctrle: '\x05',
  ctrll: '\x0c',
  ctrlr: '\x12',
  ctrlw: '\x17',
  ctrlu: '\x15',
  ctrlk: '\x0b',

  // Function keys (F1-F4 use SS3, F5-F12 use CSI)
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',

  // Symbols (literal characters)
  pipe: '|',
  tilde: '~',
  backtick: '`',
  backslash: '\\',
  slash: '/',
  lbracket: '[',
  rbracket: ']',
  lbrace: '{',
  rbrace: '}',
  lparen: '(',
  rparen: ')',
  langle: '<',
  rangle: '>',
  at: '@',
  hash: '#',
  dollar: '$',
  percent: '%',
  caret: '^',
  ampersand: '&',
  asterisk: '*',
  underscore: '_',
  plus: '+',
  minus: '-',
  equals: '=',
  squote: "'",
  dquote: '"',
  semicolon: ';',
  colon: ':',
};

/** Human-readable labels for keys */
export const KEY_LABELS: Record<string, string> = {
  // Ctrl combos
  ctrlc: '^C',
  ctrld: '^D',
  ctrlz: '^Z',
  ctrla: '^A',
  ctrle: '^E',
  ctrll: '^L',
  ctrlr: '^R',
  ctrlw: '^W',
  ctrlu: '^U',
  ctrlk: '^K',

  // Function keys
  f1: 'F1',
  f2: 'F2',
  f3: 'F3',
  f4: 'F4',
  f5: 'F5',
  f6: 'F6',
  f7: 'F7',
  f8: 'F8',
  f9: 'F9',
  f10: 'F10',
  f11: 'F11',
  f12: 'F12',

  // Symbols
  pipe: '|',
  tilde: '~',
  backtick: '`',
  backslash: '\\',
  slash: '/',
  lbracket: '[',
  rbracket: ']',
  lbrace: '{',
  rbrace: '}',
  lparen: '(',
  rparen: ')',
  langle: '<',
  rangle: '>',
  at: '@',
  hash: '#',
  dollar: '$',
  percent: '%',
  caret: '^',
  ampersand: '&',
  asterisk: '*',
  underscore: '_',
  plus: '+',
  minus: '-',
  equals: '=',
  squote: "'",
  dquote: '"',
  semicolon: ';',
  colon: ':',

  // Navigation
  tab: 'Tab',
  esc: 'Esc',
  enter: '↵',
  backspace: '⌫',
  home: 'Home',
  end: 'End',
  pgup: 'PgUp',
  pgdn: 'PgDn',
  insert: 'Ins',
  delete: 'Del',
};

/** CSS class names */
export const CSS_CLASSES = {
  controller: 'touch-controller',
  visible: 'visible',
  active: 'active',
  touchMode: 'touch-mode',
} as const;

/** DOM Selectors */
export const SELECTORS = {
  controller: '#touch-controller',
  modifierKey: '.touch-modifier',
  actionKey: '.touch-key:not(.touch-modifier)',
} as const;
