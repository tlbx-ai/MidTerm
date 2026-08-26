export interface TerminalCursorActivity {
  configuredToBlink: boolean;
  documentVisible: boolean;
  documentFocused: boolean;
  terminalInputFocused: boolean;
}

/**
 * Cursor animation is useful only while the user can see and interact with the
 * owning terminal. Keeping it alive in a background Chrome window continuously
 * schedules xterm/WebGL redraws without producing a visible result.
 */
export function shouldBlinkTerminalCursor(activity: TerminalCursorActivity): boolean {
  return (
    activity.configuredToBlink &&
    activity.documentVisible &&
    activity.documentFocused &&
    activity.terminalInputFocused
  );
}
