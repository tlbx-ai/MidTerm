import { describe, expect, it } from 'vitest';

import { resolveViewportDrivenHistoryWindowCount } from './historyWindowSizing';

describe('historyWindowSizing', () => {
  it('uses observed row heights when estimating the retained history window', () => {
    const viewport = { clientHeight: 600 } as HTMLDivElement;

    const count = resolveViewportDrivenHistoryWindowCount(viewport, 30, 80, [144, 152, 148, 150]);

    expect(count).toBe(64);
  });

  it('falls back to the default estimate when no observed heights are available', () => {
    const viewport = { clientHeight: 600 } as HTMLDivElement;

    const count = resolveViewportDrivenHistoryWindowCount(viewport, 30, 80);

    expect(count).toBe(69);
  });
});
