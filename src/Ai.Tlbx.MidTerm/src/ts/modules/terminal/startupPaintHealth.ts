import type { Terminal } from '@xterm/xterm';

export type TerminalStartupPaintHealth = 'healthy' | 'blank' | 'indeterminate';
export type TerminalStartupPaintAction = 'complete' | 'retry' | 'refresh' | 'fallback';

const SAMPLE_WIDTH = 96;
const SAMPLE_HEIGHT = 54;
const MIN_EXPECTED_VISIBLE_CHARACTERS = 12;

export function countVisibleTerminalCharacters(terminal: Terminal): number {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.viewportY);
  const end = Math.min(buffer.length, start + terminal.rows);
  let count = 0;

  for (let index = start; index < end; index += 1) {
    const line = buffer.getLine(index)?.translateToString(true) ?? '';
    count += line.replace(/\s/g, '').length;
  }

  return count;
}

export function classifyTerminalStartupPixels(
  pixels: Uint8ClampedArray,
  expectedVisibleCharacters: number,
): TerminalStartupPaintHealth {
  if (expectedVisibleCharacters < MIN_EXPECTED_VISIBLE_CHARACTERS || pixels.length < 4) {
    return 'indeterminate';
  }

  const colorCounts = new Map<number, number>();
  let totalPixels = 0;
  let dominantCount = 0;

  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3] ?? 0;
    const key =
      alpha < 8
        ? 0
        : (((pixels[index] ?? 0) >> 4) << 12) |
          (((pixels[index + 1] ?? 0) >> 4) << 8) |
          (((pixels[index + 2] ?? 0) >> 4) << 4) |
          Math.min(15, alpha >> 4);
    const count = (colorCounts.get(key) ?? 0) + 1;
    colorCounts.set(key, count);
    dominantCount = Math.max(dominantCount, count);
    totalPixels += 1;
  }

  const nonDominantPixels = totalPixels - dominantCount;
  const requiredPaintedPixels = Math.min(
    32,
    Math.max(4, Math.floor(expectedVisibleCharacters / 20)),
  );
  return nonDominantPixels >= requiredPaintedPixels ? 'healthy' : 'blank';
}

export function inspectTerminalStartupPaint(
  terminal: Terminal,
  container: HTMLElement,
): TerminalStartupPaintHealth {
  const expectedVisibleCharacters = countVisibleTerminalCharacters(terminal);
  if (expectedVisibleCharacters < MIN_EXPECTED_VISIBLE_CHARACTERS) {
    return 'indeterminate';
  }

  const canvases = [...container.querySelectorAll('canvas')].filter(
    (canvas) => canvas.width > 0 && canvas.height > 0,
  );
  if (canvases.length === 0) {
    const domRows = container.querySelector('.xterm-rows')?.textContent ?? '';
    return domRows.replace(/\s/g, '').length >= MIN_EXPECTED_VISIBLE_CHARACTERS
      ? 'healthy'
      : 'blank';
  }

  try {
    const sample = document.createElement('canvas');
    sample.width = SAMPLE_WIDTH;
    sample.height = SAMPLE_HEIGHT;
    const context = sample.getContext('2d', { willReadFrequently: true });
    if (!context) return 'indeterminate';

    context.clearRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    for (const canvas of canvases) {
      context.drawImage(canvas, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    }
    return classifyTerminalStartupPixels(
      context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data,
      expectedVisibleCharacters,
    );
  } catch {
    // Image protocols can taint the renderer canvas. Unknown paint state must
    // never disrupt a terminal that may already be displaying valid content.
    return 'indeterminate';
  }
}

export function getTerminalStartupPaintAction(
  health: TerminalStartupPaintHealth,
  consecutiveBlankChecks: number,
  attempt: number,
  maxAttempts: number,
): TerminalStartupPaintAction {
  if (health === 'healthy') return 'complete';
  if (health === 'indeterminate') return attempt < maxAttempts ? 'retry' : 'complete';
  return consecutiveBlankChecks <= 1 ? 'refresh' : 'fallback';
}
