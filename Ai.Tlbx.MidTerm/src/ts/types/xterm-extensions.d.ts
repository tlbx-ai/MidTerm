/**
 * Type extensions for xterm.js internal properties and non-standard CSS.
 *
 * These declarations extend the official xterm.js types to include internal
 * properties we access (like Terminal.modes) and non-standard CSS properties
 * (like CSSStyleDeclaration.zoom).
 */

import type { Terminal } from '@xterm/xterm';
import type { TerminalState, Settings } from '../types';

// Extend Terminal with internal properties we access
declare module '@xterm/xterm' {
  interface Terminal {
    modes?: {
      bracketedPasteMode?: boolean;
    };
  }
}

// Extend CSSStyleDeclaration with non-standard zoom property
declare global {
  interface CSSStyleDeclaration {
    zoom: string;
  }

  interface Window {
    mmDebug?: {
      readonly terminals: Map<string, TerminalState>;
      readonly activeId: string | null;
      readonly settings: Settings | null;
    };
  }
}

export {};
