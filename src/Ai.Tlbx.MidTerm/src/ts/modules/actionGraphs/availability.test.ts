import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { isActionGraphsAvailable } from './availability';

describe('Action Graph availability', () => {
  it('requires explicit settings opt-in even in developer mode', () => {
    expect(isActionGraphsAvailable(undefined)).toBe(false);
    expect(isActionGraphsAvailable({ actionGraphsEnabled: false })).toBe(false);
    expect(isActionGraphsAvailable({ actionGraphsEnabled: false, devMode: true })).toBe(false);
    expect(isActionGraphsAvailable({ actionGraphsEnabled: true, devMode: false })).toBe(true);
  });

  it('keeps the opt-in sidebar entry hidden until availability enables it', () => {
    const html = readFileSync(new URL('../../../static/index.html', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../../../static/css/app.css', import.meta.url), 'utf8');

    expect(html).toContain('class="sidebar-nav-btn btn-action-graphs hidden"');
    expect(css).toMatch(/\.sidebar-nav-btn\.hidden\s*\{\s*display:\s*none;\s*\}/);
  });
});
