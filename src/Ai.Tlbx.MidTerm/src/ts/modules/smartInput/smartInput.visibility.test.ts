import { describe, expect, it } from 'vitest';

import { shouldShowDockedSmartInput, shouldShowAppServerControlQuickSettings } from './visibility';

describe('smart input visibility', () => {
  it('hides all docked smart input chrome when no session is active', () => {
    expect(
      shouldShowDockedSmartInput({
        activeSessionId: null,
        inputMode: 'both',
        appServerControlActive: false,
      }),
    ).toBe(false);
    expect(
      shouldShowAppServerControlQuickSettings({
        activeSessionId: null,
        inputMode: 'both',
        appServerControlActive: true,
      }),
    ).toBe(false);
  });

  it('keeps AppServerControl quick settings scoped to explicit AppServerControl sessions only', () => {
    expect(
      shouldShowAppServerControlQuickSettings({
        activeSessionId: 'terminal-1',
        inputMode: 'both',
        appServerControlActive: false,
      }),
    ).toBe(false);
    expect(
      shouldShowAppServerControlQuickSettings({
        activeSessionId: 'appServerControl-1',
        inputMode: 'both',
        appServerControlActive: true,
      }),
    ).toBe(true);
  });

  it('still allows docked smart input for normal terminal modes once a session is active', () => {
    expect(
      shouldShowDockedSmartInput({
        activeSessionId: 'terminal-1',
        inputMode: 'smartinput',
        appServerControlActive: false,
      }),
    ).toBe(true);
    expect(
      shouldShowDockedSmartInput({
        activeSessionId: 'terminal-1',
        inputMode: 'keyboard',
        appServerControlActive: false,
      }),
    ).toBe(false);
  });
});
