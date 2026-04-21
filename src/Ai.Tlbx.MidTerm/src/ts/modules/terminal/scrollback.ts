import type { TerminalState } from '../../types';

export function isTerminalViewingScrollback(state: Pick<TerminalState, 'terminal'>): boolean {
  const buffer = state.terminal.buffer.active;
  return buffer.viewportY < buffer.baseY;
}
