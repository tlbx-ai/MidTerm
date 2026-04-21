import { describe, expect, it } from 'vitest';

import { buildPreviewTabLabel } from './webPreviewTabLabel';

describe('webPreviewTabLabel', () => {
  it('uses host and port for the visible tab label', () => {
    expect(buildPreviewTabLabel('https://localhost:3000/some/path?q=1')).toBe('localhost:3000');
  });

  it('falls back to New Tab when there is no target yet', () => {
    expect(buildPreviewTabLabel(null)).toBe('New Tab');
    expect(buildPreviewTabLabel('   ')).toBe('New Tab');
  });

  it('keeps a malformed raw value visible instead of leaking the internal preview key', () => {
    expect(buildPreviewTabLabel('localhost:3000')).toBe('localhost:3000');
  });
});
