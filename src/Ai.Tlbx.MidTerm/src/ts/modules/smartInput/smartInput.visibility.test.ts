import { describe, expect, it } from 'vitest';

import { shouldShowDockedSmartInput, shouldShowLensQuickSettings } from './visibility';

describe('smart input visibility', () => {
  it('hides all docked smart input chrome when no session is active', () => {
    expect(
      shouldShowDockedSmartInput({
        activeSessionId: null,
        inputMode: 'both',
        lensActive: false,
      }),
    ).toBe(false);
    expect(
      shouldShowLensQuickSettings({
        activeSessionId: null,
        inputMode: 'both',
        lensActive: true,
      }),
    ).toBe(false);
  });

  it('keeps Lens quick settings scoped to explicit Lens sessions only', () => {
    expect(
      shouldShowLensQuickSettings({
        activeSessionId: 'terminal-1',
        inputMode: 'both',
        lensActive: false,
      }),
    ).toBe(false);
    expect(
      shouldShowLensQuickSettings({
        activeSessionId: 'lens-1',
        inputMode: 'both',
        lensActive: true,
      }),
    ).toBe(true);
  });

  it('still allows docked smart input for normal terminal modes once a session is active', () => {
    expect(
      shouldShowDockedSmartInput({
        activeSessionId: 'terminal-1',
        inputMode: 'smartinput',
        lensActive: false,
      }),
    ).toBe(true);
    expect(
      shouldShowDockedSmartInput({
        activeSessionId: 'terminal-1',
        inputMode: 'keyboard',
        lensActive: false,
      }),
    ).toBe(false);
  });
});
