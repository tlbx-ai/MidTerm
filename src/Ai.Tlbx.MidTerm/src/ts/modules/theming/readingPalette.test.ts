import { describe, expect, it } from 'vitest';
import { CSS_THEMES } from './cssThemes';
import { createReadingPalette, readingContrast, type ReadingRgb } from './readingPalette';

describe('workspace reading contrast', () => {
  for (const [name, css] of Object.entries(CSS_THEMES))
    for (const transparency of [0, 65, 90, 100]) {
      it(`${name} remains readable at ${transparency}% over all wallpaper extremes and semantic states`, () => {
        const palette: Record<string, ReadingRgb> = {};
        for (const [key, value] of Object.entries(css))
          if (/^#[\da-f]{6}$/i.test(value))
            palette[key] = {
              r: parseInt(value.slice(1, 3), 16),
              g: parseInt(value.slice(3, 5), 16),
              b: parseInt(value.slice(5, 7), 16),
            };
        const result = createReadingPalette(palette, 1 - transparency / 100);
        expect(result.alpha).toBeGreaterThanOrEqual(0.88);
        if (transparency === 0) expect(result.alpha).toBe(1);
        for (const color of Object.values(result.colors))
          for (const bg of result.backgrounds)
            expect(readingContrast(color, bg)).toBeGreaterThanOrEqual(4.8);
      });
    }
});
