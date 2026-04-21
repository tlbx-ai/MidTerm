import type { MidTermSettingsPublic, TerminalState } from '../../types';
import { getEffectiveTerminalCellBackgroundAlpha } from '../theming/themes';

interface ParsedColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface CachedInlineBackground {
  source: ParsedColor;
  processed: string;
}

interface ElementLike {
  style: { backgroundColor: string };
  children: { length: number; item(index: number): unknown };
}

const processedInlineBackgrounds = new WeakMap<HTMLElement, CachedInlineBackground>();

export function syncTerminalRgbBackgroundTransparency(
  state: TerminalState,
  settings: MidTermSettingsPublic | null,
): void {
  const alpha = getEffectiveTerminalCellBackgroundAlpha(settings);
  const shouldRewriteInlineBackgrounds = state.opened && !state.hasWebgl && alpha < 1;

  if (shouldRewriteInlineBackgrounds) {
    state.richBackgroundTransparencyAlpha = alpha;

    if (!state.richBackgroundTransparencyDisposable) {
      state.richBackgroundTransparencyDisposable = state.terminal.onRender((event) => {
        const currentAlpha = state.richBackgroundTransparencyAlpha;
        if (currentAlpha === null || currentAlpha === undefined || currentAlpha >= 1) {
          return;
        }

        applyInlineBackgroundTransparencyToRenderedRows(
          state.container,
          event.start,
          event.end,
          currentAlpha,
        );
      });
    }

    applyInlineBackgroundTransparencyToRenderedRows(
      state.container,
      0,
      state.terminal.rows - 1,
      alpha,
    );
    return;
  }

  if (state.richBackgroundTransparencyDisposable) {
    applyInlineBackgroundTransparencyToRenderedRows(state.container, 0, state.terminal.rows - 1, 1);
    state.richBackgroundTransparencyDisposable.dispose();
    state.richBackgroundTransparencyDisposable = undefined;
  }

  state.richBackgroundTransparencyAlpha = null;
}

export function disposeTerminalRgbBackgroundTransparency(state: TerminalState): void {
  state.richBackgroundTransparencyDisposable?.dispose();
  state.richBackgroundTransparencyDisposable = undefined;
  state.richBackgroundTransparencyAlpha = null;
}

export function applyInlineBackgroundTransparencyToRenderedRows(
  container: ParentNode,
  startRow: number,
  endRow: number,
  alpha: number,
): void {
  const rowContainer = container.querySelector('.xterm-rows');
  if (!isElementLike(rowContainer)) {
    return;
  }

  const rows = rowContainer.children;
  if (rows.length === 0) {
    return;
  }

  const firstRow = clamp(Math.min(startRow, endRow), 0, rows.length - 1);
  const lastRow = clamp(Math.max(startRow, endRow), 0, rows.length - 1);

  for (let index = firstRow; index <= lastRow; index++) {
    const row = rows.item(index);
    if (!isElementLike(row)) {
      continue;
    }

    rewriteRowInlineBackgrounds(row, alpha);
  }
}

function rewriteRowInlineBackgrounds(row: ElementLike, alpha: number): void {
  const elements = row.children;

  for (let index = 0; index < elements.length; index++) {
    const element = elements.item(index);
    if (!isElementLike(element)) {
      continue;
    }

    rewriteInlineBackgroundTransparency(element, alpha);
  }
}

function rewriteInlineBackgroundTransparency(element: ElementLike, alpha: number): void {
  const currentBackground = element.style.backgroundColor;
  if (currentBackground.length === 0) {
    processedInlineBackgrounds.delete(element as HTMLElement);
    return;
  }

  const cached = processedInlineBackgrounds.get(element as HTMLElement);
  const source =
    cached && currentBackground === cached.processed
      ? cached.source
      : parseCssColor(currentBackground);

  if (!source) {
    processedInlineBackgrounds.delete(element as HTMLElement);
    return;
  }

  const nextBackground = formatCssColor(source, source.a * alpha);
  if (currentBackground !== nextBackground) {
    element.style.backgroundColor = nextBackground;
  }

  processedInlineBackgrounds.set(element as HTMLElement, {
    source,
    processed: element.style.backgroundColor,
  });
}

function parseCssColor(value: string): ParsedColor | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('#')) {
    return parseHexColor(trimmed);
  }

  const rgbMatch = trimmed.match(/rgba?\(([^)]+)\)/i);
  if (!rgbMatch) {
    return null;
  }

  const parts = rgbMatch[1]?.split(',').map((part) => Number.parseFloat(part.trim()));
  if (!parts || parts.length < 3) {
    return null;
  }

  const r = parts[0];
  const g = parts[1];
  const b = parts[2];
  const a = parts[3] ?? 1;
  if (
    r === undefined ||
    g === undefined ||
    b === undefined ||
    ![r, g, b, a].every((part) => Number.isFinite(part))
  ) {
    return null;
  }

  return {
    r: clamp(Math.round(r), 0, 255),
    g: clamp(Math.round(g), 0, 255),
    b: clamp(Math.round(b), 0, 255),
    a: clamp(a, 0, 1),
  };
}

function parseHexColor(value: string): ParsedColor | null {
  const hex = value.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    const [r, g, b, a = 'f'] = hex.split('');
    if (!r || !g || !b) {
      return null;
    }

    return {
      r: Number.parseInt(r + r, 16),
      g: Number.parseInt(g + g, 16),
      b: Number.parseInt(b + b, 16),
      a: Number.parseInt(a + a, 16) / 255,
    };
  }

  if (hex.length === 6 || hex.length === 8) {
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }

  return null;
}

function formatCssColor(color: ParsedColor, alpha: number): string {
  const normalizedAlpha = clamp(alpha, 0, 1);
  if (normalizedAlpha >= 0.999) {
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
  }

  return `rgba(${color.r}, ${color.g}, ${color.b}, ${normalizedAlpha.toFixed(3)})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isElementLike(value: unknown): value is ElementLike {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<ElementLike>;
  return (
    candidate.style !== undefined &&
    typeof candidate.style.backgroundColor === 'string' &&
    candidate.children !== undefined &&
    typeof candidate.children.length === 'number' &&
    typeof candidate.children.item === 'function'
  );
}
