import type { IBufferCell, Terminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { buildTerminalBufferDumpText, makeControlSequencesVisible } from './terminalBufferDump';

function createCell(options: {
  chars?: string;
  fgPalette?: number;
  bgRgb?: number;
  bold?: boolean;
}): IBufferCell {
  return {
    getWidth: () => 1,
    getChars: () => options.chars ?? '',
    getCode: () => (options.chars ?? ' ').codePointAt(0) ?? 0,
    getFgColorMode: () => (options.fgPalette === undefined ? 0 : 1),
    getBgColorMode: () => (options.bgRgb === undefined ? 0 : 2),
    getFgColor: () => options.fgPalette ?? 0,
    getBgColor: () => options.bgRgb ?? 0,
    isBold: () => (options.bold ? 1 : 0),
    isItalic: () => 0,
    isDim: () => 0,
    isUnderline: () => 0,
    isBlink: () => 0,
    isInverse: () => 0,
    isInvisible: () => 0,
    isStrikethrough: () => 0,
    isOverline: () => 0,
    isFgRGB: () => false,
    isBgRGB: () => options.bgRgb !== undefined,
    isFgPalette: () => options.fgPalette !== undefined,
    isBgPalette: () => false,
    isFgDefault: () => options.fgPalette === undefined,
    isBgDefault: () => options.bgRgb === undefined,
    isAttributeDefault: () =>
      options.fgPalette === undefined && options.bgRgb === undefined && !options.bold,
  };
}

function createTerminal(): Terminal {
  const cells = [
    createCell({ chars: 'a' }),
    createCell({ chars: 'r', fgPalette: 1, bold: true }),
    createCell({ chars: 'e', fgPalette: 1, bold: true }),
    createCell({ chars: ' ', bgRgb: 0x112233 }),
  ];
  const line = {
    isWrapped: false,
    length: cells.length,
    getCell: (index: number): IBufferCell | undefined => cells[index],
    translateToString: () => 'are',
  };

  const activeBuffer = {
    baseY: 0,
    cursorX: 0,
    cursorY: 0,
    length: 1,
    viewportY: 0,
    getLine: () => line,
    getNullCell: () => createCell({}),
  };

  return {
    cols: 80,
    rows: 24,
    buffer: {
      active: activeBuffer,
      alternate: activeBuffer,
      normal: activeBuffer,
    },
  } as unknown as Terminal;
}

describe('terminal buffer dump', () => {
  it('renders control bytes as visible escape text', () => {
    expect(makeControlSequencesVisible('\u001b[31mred\u001b[0m\r\nbell\u0007')).toBe(
      String.raw`\x1b[31mred\x1b[0m\r` + '\n' + String.raw`bell\a`,
    );
  });

  it('includes xterm rendered text, cell colors, and raw escape text', () => {
    const report = buildTerminalBufferDumpText({
      generatedAt: new Date('2026-04-27T12:00:00.000Z'),
      rawBuffer: {
        ok: true,
        snapshot: {
          base64: 'G1szMW1yZWQbWzBt',
          byteLength: 10,
          encoding: 'utf-8',
          sessionId: 's1',
          text: '\u001b[31mred\u001b[0m',
        },
      },
      sessionId: 's1',
      terminal: createTerminal(),
    });

    expect(report).toContain('===== XTERM RENDERED BUFFER TEXT =====');
    expect(report).toContain('are');
    expect(report).toContain('fg=palette:1 bg=default attrs=bold text="re"');
    expect(report).toContain('fg=default bg=rgb:#112233 attrs=none text=" "');
    expect(report).toContain(String.raw`\x1b[31mred\x1b[0m`);
    expect(report).toContain('G1szMW1yZWQbWzBt');
  });
});
