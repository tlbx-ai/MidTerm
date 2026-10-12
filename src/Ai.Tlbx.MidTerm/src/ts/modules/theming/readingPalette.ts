export interface ReadingRgb {
  r: number;
  g: number;
  b: number;
}
export const READING_COLOR_KEYS = [
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--accent-blue',
  '--accent-cyan',
  '--accent-green',
  '--accent-orange',
  '--accent-red',
  '--accent-violet',
  '--accent-warning',
] as const;

function mix(left: ReadingRgb, right: ReadingRgb, amount: number): ReadingRgb {
  return {
    r: left.r * amount + right.r * (1 - amount),
    g: left.g * amount + right.g * (1 - amount),
    b: left.b * amount + right.b * (1 - amount),
  };
}
function luminance(color: ReadingRgb): number {
  const linear = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}
export function readingContrast(left: ReadingRgb, right: ReadingRgb): number {
  const a = luminance(left),
    b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function rounded(color: ReadingRgb): ReadingRgb {
  return { r: Math.round(color.r), g: Math.round(color.g), b: Math.round(color.b) };
}
function protect(color: ReadingRgb, backgrounds: ReadingRgb[], anchor: ReadingRgb): ReadingRgb {
  const passes = (value: ReadingRgb): boolean =>
    backgrounds.every((bg) => readingContrast(value, bg) >= 4.8);
  if (passes(color)) return color;
  let low = 0,
    high = 1;
  for (let i = 0; i < 12; i++) {
    const step = (low + high) / 2;
    if (passes(rounded(mix(anchor, color, step)))) high = step;
    else low = step;
  }
  return rounded(mix(anchor, color, high));
}

/** Local reading scrim and palette; UI/terminal transparency elsewhere remains user-owned. */
export function createReadingPalette(
  palette: Record<string, ReadingRgb>,
  uiAlpha: number,
): {
  alpha: number;
  backgrounds: ReadingRgb[];
  colors: Record<string, ReadingRgb>;
} {
  const background = palette['--bg-primary'] ?? { r: 13, g: 14, b: 20 };
  const alpha = Math.min(1, Math.max(0.88, uiAlpha * 1.16));
  const backgrounds: ReadingRgb[] = [];
  const bases = [
    mix(background, { r: 0, g: 0, b: 0 }, alpha),
    mix(background, { r: 255, g: 255, b: 255 }, alpha),
  ];
  const overlays: Array<[string, number]> = [
    ['--bg-elevated', Math.max(alpha, Math.min(1, uiAlpha * 1.22))],
    ['--bg-input', 1],
    ['--bg-active', Math.min(1, uiAlpha * 1.4)],
    ['--bg-hover', Math.min(1, uiAlpha * 1.34)],
    ['--accent-blue', 0.4],
    ['--accent-blue', 0.25],
    ['--accent-green', 0.18],
    ['--accent-red', 0.18],
    ['--accent-orange', 0.18],
  ];
  for (const base of bases) {
    backgrounds.push(base);
    for (const [key, opacity] of overlays) {
      const color = palette[key];
      if (color) backgrounds.push(mix(color, base, opacity));
    }
  }
  const anchor = luminance(background) < 0.35 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  const colors: Record<string, ReadingRgb> = {};
  for (const key of READING_COLOR_KEYS) {
    const color = palette[key];
    if (color) colors[key] = protect(color, backgrounds, anchor);
  }
  return { alpha, backgrounds, colors };
}
