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
export const JS_BUILD_VERSION: string = typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : 'dev';

// =============================================================================
// Mux Protocol Constants
// =============================================================================

/** Mux protocol header size (1 byte type + 8 byte session ID) */
export const MUX_HEADER_SIZE = 9;

/** Mux protocol message types */
export const MUX_TYPE_OUTPUT = 0x01;  // Server -> Client: Terminal output (includes dimensions)
export const MUX_TYPE_INPUT = 0x02;   // Client -> Server: Terminal input
export const MUX_TYPE_RESIZE = 0x03;  // Client -> Server: Terminal resize
export const MUX_TYPE_RESYNC = 0x05;  // Server -> Client: Clear terminals, buffer refresh follows
export const MUX_TYPE_BUFFER_REQUEST = 0x06; // Client -> Server: Request buffer refresh
export const MUX_TYPE_COMPRESSED_OUTPUT = 0x07; // Server -> Client: GZip compressed output

// =============================================================================
// Terminal Themes
// =============================================================================

/** Terminal color themes */
export const THEMES: Record<ThemeName, TerminalTheme> = {
  dark: {
    background: '#06060E',
    foreground: '#DCDCF5',
    cursor: '#DCDCF5',
    cursorAccent: '#06060E',
    selectionBackground: '#283457'
  },
  light: {
    background: '#D5D6DB',
    foreground: '#343B58',
    cursor: '#343B58',
    cursorAccent: '#D5D6DB',
    selectionBackground: '#9FA0A5'
  },
  solarizedDark: {
    background: '#002B36',
    foreground: '#839496',
    cursor: '#839496',
    cursorAccent: '#002B36',
    selectionBackground: '#073642'
  },
  solarizedLight: {
    background: '#FDF6E3',
    foreground: '#657B83',
    cursor: '#657B83',
    cursorAccent: '#FDF6E3',
    selectionBackground: '#EEE8D5'
  }
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
  clipboardShortcuts: 'auto' as const
};

// =============================================================================
// WebSocket Configuration
// =============================================================================

/** Initial reconnect delay in milliseconds */
export const INITIAL_RECONNECT_DELAY = 1000;

/** Maximum reconnect delay in milliseconds */
export const MAX_RECONNECT_DELAY = 30000;

// =============================================================================
// Terminal Rendering Constants
// =============================================================================

/** Terminal font stack for monospace rendering */
export const TERMINAL_FONT_STACK = "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace";

/** Character width as ratio of font size (empirical for monospace fonts) */
export const FONT_CHAR_WIDTH_RATIO = 0.6;

/** Line height as ratio of font size */
export const FONT_LINE_HEIGHT_RATIO = 1.2;

/** Padding around terminal content in pixels */
export const TERMINAL_PADDING = 8;

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
