/**
 * Constants
 *
 * Protocol constants, theme definitions, and configuration values.
 */

import type { TerminalTheme, ThemeName } from './types';

// =============================================================================
// Build Version (injected at compile time via esbuild --define)
// =============================================================================

/** Version injected at build time - DO NOT MODIFY, replaced by esbuild */
declare const BUILD_VERSION: string;

/** The version this JavaScript was compiled for */
export const JS_BUILD_VERSION: string =
  typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : 'dev';

// =============================================================================
// Mux Protocol Constants
// =============================================================================

/** Mux protocol header size (1 byte type + 8 byte session ID) */
export const MUX_HEADER_SIZE = 9;

/** Mux protocol version - increment when making breaking protocol changes */
export const MUX_PROTOCOL_VERSION = 1;

/** Minimum compatible protocol version */
export const MUX_MIN_COMPATIBLE_VERSION = 1;

/** Mux protocol message types */
export const MUX_TYPE_OUTPUT = 0x01; // Server -> Client: Terminal output (includes dimensions)
export const MUX_TYPE_INPUT = 0x02; // Client -> Server: Terminal input
export const MUX_TYPE_RESIZE = 0x03; // Client -> Server: Terminal resize
export const MUX_TYPE_RESYNC = 0x05; // Server -> Client: Clear terminals, buffer refresh follows
export const MUX_TYPE_BUFFER_REQUEST = 0x06; // Client -> Server: Request buffer refresh
export const MUX_TYPE_COMPRESSED_OUTPUT = 0x07; // Server -> Client: GZip compressed output
export const MUX_TYPE_ACTIVE_HINT = 0x08; // Client -> Server: Hint which session is active
export const MUX_TYPE_PING = 0x09; // Client -> Server: Latency measurement ping
export const MUX_TYPE_FOREGROUND_CHANGE = 0x0a; // Server -> Client: Foreground process changed
export const MUX_TYPE_DATA_LOSS = 0x0b; // Server -> Client: Background session lost data
export const MUX_TYPE_PONG = 0x0c; // Server -> Client: Latency measurement pong

// Custom WebSocket close codes (4000-4999 range)
export const WS_CLOSE_AUTH_FAILED = 4401;
export const WS_CLOSE_SERVER_SHUTDOWN = 4503;
export const WS_CLOSE_PROTOCOL_ERROR = 4400;

// =============================================================================
// Terminal Themes
// =============================================================================

/** Terminal color themes */
export const THEMES: Record<ThemeName, TerminalTheme> = {
  dark: {
    background: '#05050A',
    foreground: '#E0E2F0',
    cursor: '#E0E2F0',
    cursorAccent: '#05050A',
    selectionBackground: '#2D3044',
    scrollbarSliderBackground: 'rgba(58, 62, 82, 0.5)',
    scrollbarSliderHoverBackground: 'rgba(123, 162, 247, 0.5)',
    scrollbarSliderActiveBackground: 'rgba(123, 162, 247, 0.7)',
  },
  light: {
    background: '#F8F9FA',
    foreground: '#1A1B26',
    cursor: '#1A1B26',
    cursorAccent: '#F8F9FA',
    selectionBackground: '#B4D7FF',
    scrollbarSliderBackground: 'rgba(26, 27, 38, 0.15)',
    scrollbarSliderHoverBackground: 'rgba(26, 27, 38, 0.3)',
    scrollbarSliderActiveBackground: 'rgba(26, 27, 38, 0.45)',
    black: '#FAFBFC',
    red: '#CD3131',
    green: '#008000',
    yellow: '#795E26',
    blue: '#0451A5',
    magenta: '#AF00DB',
    cyan: '#0598BC',
    white: '#1A1B26',
    brightBlack: '#A0A1A7',
    brightRed: '#E45649',
    brightGreen: '#50A14F',
    brightYellow: '#C18401',
    brightBlue: '#4078F2',
    brightMagenta: '#A626A4',
    brightCyan: '#0184BC',
    brightWhite: '#383A42',
  },
  solarizedDark: {
    background: '#002B36',
    foreground: '#839496',
    cursor: '#839496',
    cursorAccent: '#002B36',
    selectionBackground: '#0D4A58',
    scrollbarSliderBackground: 'rgba(131, 148, 150, 0.3)',
    scrollbarSliderHoverBackground: 'rgba(131, 148, 150, 0.5)',
    scrollbarSliderActiveBackground: 'rgba(131, 148, 150, 0.7)',
    black: '#073642',
    red: '#DC322F',
    green: '#859900',
    yellow: '#B58900',
    blue: '#268BD2',
    magenta: '#D33682',
    cyan: '#2AA198',
    white: '#EEE8D5',
    brightBlack: '#586E75',
    brightRed: '#CB4B16',
    brightGreen: '#A4BD00',
    brightYellow: '#D4A017',
    brightBlue: '#54A3D8',
    brightMagenta: '#6C71C4',
    brightCyan: '#54BDB2',
    brightWhite: '#FDF6E3',
  },
  solarizedLight: {
    background: '#FDF6E3',
    foreground: '#657B83',
    cursor: '#657B83',
    cursorAccent: '#FDF6E3',
    selectionBackground: '#D3E5ED',
    scrollbarSliderBackground: 'rgba(101, 123, 131, 0.3)',
    scrollbarSliderHoverBackground: 'rgba(101, 123, 131, 0.5)',
    scrollbarSliderActiveBackground: 'rgba(101, 123, 131, 0.7)',
    black: '#FDF6E3',
    red: '#DC322F',
    green: '#859900',
    yellow: '#B58900',
    blue: '#268BD2',
    magenta: '#D33682',
    cyan: '#2AA198',
    white: '#073642',
    brightBlack: '#586E75',
    brightRed: '#CB4B16',
    brightGreen: '#6C8A00',
    brightYellow: '#946D00',
    brightBlue: '#1B7FC4',
    brightMagenta: '#6C71C4',
    brightCyan: '#1F8E85',
    brightWhite: '#002B36',
  },
};

// =============================================================================
// Default Settings
// =============================================================================

/** Default terminal settings */
export const DEFAULT_SETTINGS = {
  fontSize: 14,
  scrollbackLines: 10000,
  cursorStyle: 'bar' as const,
  cursorBlink: true,
  theme: 'dark' as ThemeName,
  bellStyle: 'notification' as const,
  copyOnSelect: false,
  rightClickPaste: true,
  clipboardShortcuts: 'auto' as const,
};

// =============================================================================
// WebSocket Configuration
// =============================================================================

/** Fixed reconnect delay in milliseconds */
export const RECONNECT_DELAY = 3000;

// =============================================================================
// Terminal Rendering Constants
// =============================================================================

/** Terminal font stack for monospace rendering */
export const TERMINAL_FONT_STACK =
  "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace";

/** Padding around terminal content in pixels */
export const TERMINAL_PADDING = 8;

/** Reserved space for xterm's overlay scrollbar (0 = scrollbar overlays text) */
export const SCROLLBAR_WIDTH = 0;

/** Minimum terminal columns */
export const MIN_TERMINAL_COLS = 10;

/** Minimum terminal rows */
export const MIN_TERMINAL_ROWS = 5;

/** Maximum terminal columns */
export const MAX_TERMINAL_COLS = 300;

/** Maximum terminal rows */
export const MAX_TERMINAL_ROWS = 100;

/** Maximum frame dimension for validation */
export const MAX_FRAME_DIMENSION = 500;

/** Mobile breakpoint in pixels */
export const MOBILE_BREAKPOINT = 768;

// =============================================================================
// Icon Font (midFont) - Unicode characters
// =============================================================================

export const ICONS = {
  collapse: '\ue913', // keyboard_arrow_up
  expand: '\ue910', // keyboard_arrow_down
  settings: '\ue991', // wrench
  new: '\uea81', // terminal
  resize: '\ue989', // enlarge
  rename: '\ue91f', // drive_file_rename_outline
  close: '\ue909', // bomb
  menu: '\ue919', // menu (hamburger)
  update: '\ue91b', // arrow_right
  searchPrev: '\ue913', // keyboard_arrow_up
  searchNext: '\ue910', // keyboard_arrow_down
  save: '\ue90f', // save
  interrupt: '\ue9b5', // power
  terminal: '\uea81', // terminal
  warning: '\uea07', // warning
  tabGeneral: '\uea0c', // info
  tabAppearance: '\ue90d', // eyedropper
  tabBehavior: '\ue993', // equalizer2
  tabSecurity: '\ue908', // key
  tabDiagnostics: '\ue9ce', // eye
  more: '\ue918', // more_vert (vertical dots)
  history: '\ue967', // history (clock with arrow)
  undock: '\ue920', // close_fullscreen
  fullscreen: '\ue90c', // expand (open fullscreen)
} as const;

/** Creates an icon span element */
export function icon(name: keyof typeof ICONS): string {
  return `<span class="icon">${ICONS[name]}</span>`;
}
