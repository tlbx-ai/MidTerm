import { describe, expect, it } from 'vitest';

import { isActionGraphsAvailable } from './availability';

describe('Action Graph availability', () => {
  it('requires explicit settings opt-in even in developer mode', () => {
    expect(isActionGraphsAvailable(undefined)).toBe(false);
    expect(isActionGraphsAvailable({ actionGraphsEnabled: false })).toBe(false);
    expect(isActionGraphsAvailable({ actionGraphsEnabled: false, devMode: true })).toBe(false);
    expect(isActionGraphsAvailable({ actionGraphsEnabled: true, devMode: false })).toBe(true);
  });
});
