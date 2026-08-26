import { describe, expect, it, vi } from 'vitest';
import {
  runWithGuaranteedTerminalReplay,
  shouldRequestInitialTerminalReplay,
} from './guaranteedReplay';

describe('runWithGuaranteedTerminalReplay', () => {
  it('replays buffered output even when optional terminal initialization throws', () => {
    const failure = new Error('ligature addon failed');
    const replay = vi.fn();
    const report = vi.fn();

    runWithGuaranteedTerminalReplay(
      () => {
        throw failure;
      },
      replay,
      report,
    );

    expect(report).toHaveBeenCalledWith(failure);
    expect(replay).toHaveBeenCalledOnce();
  });

  it('requests recovery only while no terminal output has rendered', () => {
    expect(shouldRequestInitialTerminalReplay(null)).toBe(true);
    expect(shouldRequestInitialTerminalReplay(0n)).toBe(true);
    expect(shouldRequestInitialTerminalReplay(1n)).toBe(false);
  });
});
