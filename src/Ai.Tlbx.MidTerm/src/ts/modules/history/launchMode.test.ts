import { describe, expect, it, vi } from 'vitest';

vi.mock('../i18n', () => ({
  t: (key: string) =>
    (
      {
        'session.terminal': 'Terminal',
        'sessionTabs.agent': 'Lens',
        'sessionLauncher.codexTitle': 'Codex',
        'sessionLauncher.claudeTitle': 'Claude',
      } as Record<string, string>
    )[key] ?? key,
}));

describe('history launch mode helpers', () => {
  it('defaults legacy entries to terminal mode', async () => {
    const { normalizeHistoryLaunchMode, isLensHistoryEntry, getHistoryModeDisplayText } =
      await import('./launchMode');

    expect(normalizeHistoryLaunchMode(undefined)).toBe('terminal');
    expect(isLensHistoryEntry({})).toBe(false);
    expect(getHistoryModeDisplayText({})).toBe('Terminal');
  });

  it('keeps lens entries provider-specific', async () => {
    const { isLensHistoryEntry, getHistoryModeDisplayText, resolveSessionHistoryMode } =
      await import('./launchMode');

    expect(isLensHistoryEntry({ launchMode: 'lens', profile: 'claude' })).toBe(true);
    expect(getHistoryModeDisplayText({ launchMode: 'lens', profile: 'claude' })).toBe(
      'Lens · Claude',
    );
    expect(
      resolveSessionHistoryMode({
        lensOnly: true,
        profileHint: 'codex',
      }),
    ).toEqual({
      launchMode: 'lens',
      profile: 'codex',
    });
  });
});
