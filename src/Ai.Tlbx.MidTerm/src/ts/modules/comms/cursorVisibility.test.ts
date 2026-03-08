import { describe, expect, it } from 'vitest';
import { processCursorVisibilityControls } from './cursorVisibility';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function text(value: string): number[] {
  return Array.from(encoder.encode(value));
}

describe('processCursorVisibilityControls', () => {
  it('tracks DECTCEM visibility without changing data when suppression is off', () => {
    const data = Uint8Array.from([
      ...text('pre'),
      0x1b,
      0x5b,
      0x3f,
      0x32,
      0x35,
      0x6c,
      ...text('post'),
    ]);

    const result = processCursorVisibilityControls(data, false);

    expect(result.data).toBe(data);
    expect(result.remoteCursorVisible).toBe(false);
    expect(result.hadCursorVisibilityControl).toBe(true);
  });

  it('strips cursor visibility controls while preserving the surrounding frame', () => {
    const data = Uint8Array.from([
      ...text('A'),
      0x1b,
      0x5b,
      0x3f,
      0x32,
      0x35,
      0x6c,
      ...text('B'),
      0x1b,
      0x5b,
      0x3f,
      0x32,
      0x35,
      0x68,
      ...text('C'),
    ]);

    const result = processCursorVisibilityControls(data, true);

    expect(decoder.decode(result.data)).toBe('ABC');
    expect(result.remoteCursorVisible).toBe(true);
    expect(result.hadCursorVisibilityControl).toBe(true);
  });

  it('understands both 8-bit CSI encodings used by some TUIs', () => {
    const raw8Bit = Uint8Array.from([0x9b, 0x3f, 0x32, 0x35, 0x6c, ...text('x')]);
    const utf8C1 = Uint8Array.from([0xc2, 0x9b, 0x3f, 0x32, 0x35, 0x68, ...text('y')]);

    const raw8BitResult = processCursorVisibilityControls(raw8Bit, true);
    const utf8C1Result = processCursorVisibilityControls(utf8C1, true);

    expect(decoder.decode(raw8BitResult.data)).toBe('x');
    expect(raw8BitResult.remoteCursorVisible).toBe(false);
    expect(decoder.decode(utf8C1Result.data)).toBe('y');
    expect(utf8C1Result.remoteCursorVisible).toBe(true);
  });
});
