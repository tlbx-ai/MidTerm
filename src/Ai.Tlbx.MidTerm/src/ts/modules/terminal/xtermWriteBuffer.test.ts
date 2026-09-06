import { afterEach, describe, expect, it, vi } from 'vitest';
import { WriteBuffer } from '../../../../node_modules/@xterm/xterm/src/common/input/WriteBuffer';
import { Terminal } from '@xterm/xterm';

describe('patched xterm write buffer recovery barriers', () => {
  afterEach(() => vi.useRealTimers());

  it('ships the fix through the public terminal bundle and real resize path', () => {
    vi.useFakeTimers();
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const completed: string[] = [];
    try {
      terminal.write('', () => completed.push('barrier'));
      terminal.write('replayed output', () => completed.push('output'));
      terminal.resize(81, 24);
      expect(completed).toEqual(['barrier', 'output']);
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('replayed output');
    } finally {
      terminal.dispose();
    }
  });

  it('preserves an empty recovery barrier and following output during a synchronous resize flush', () => {
    vi.useFakeTimers();
    const parsed: string[] = [];
    const completed: string[] = [];
    const buffer = new WriteBuffer((data) => {
      parsed.push(String(data));
    });
    try {
      buffer.write('', () => completed.push('barrier'));
      buffer.write('retained terminal output', () => completed.push('output'));
      buffer.flushSync();
      expect(completed).toEqual(['barrier', 'output']);
      expect(parsed).toEqual(['', 'retained terminal output']);
    } finally {
      buffer.dispose();
    }
  });

  it('preserves empty barriers when synchronous writes drain an existing queue', () => {
    vi.useFakeTimers();
    const parsed: string[] = [];
    const completed = vi.fn();
    const buffer = new WriteBuffer((data) => {
      parsed.push(String(data));
    });
    try {
      buffer.write('', completed);
      buffer.writeSync('new output');
      expect(completed).toHaveBeenCalledOnce();
      expect(parsed).toEqual(['', 'new output']);
    } finally {
      buffer.dispose();
    }
  });
});
