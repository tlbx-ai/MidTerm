import { describe, expect, it } from 'vitest';

import { buildLineNumberText, formatBinaryDump } from './rendering';

describe('fileViewer rendering', () => {
  it('builds aligned line number text with a minimum of one line', () => {
    expect(buildLineNumberText(0)).toBe('1');
    expect(buildLineNumberText(4)).toBe('1\n2\n3\n4');
  });

  it('formats binary bytes as hex and ascii', () => {
    const dump = formatBinaryDump(new Uint8Array([0x41, 0x42, 0x00, 0x7f, 0x20]));

    expect(dump).toMatch(/^00000000  41 42 00 7F 20/);
    expect(dump).toContain('AB.. ');
  });

  it('starts a new row every sixteen bytes', () => {
    const bytes = new Uint8Array(17).map((_, index) => index);
    const lines = formatBinaryDump(bytes).split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^00000000/);
    expect(lines[1]).toMatch(/^00000010/);
  });
});
