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
    const {
      normalizeHistoryLaunchMode,
      isLensHistoryEntry,
      getHistoryModeDisplayText,
      getHistoryModeBadgeText,
    } =
      await import('./launchMode');

    expect(normalizeHistoryLaunchMode(undefined)).toBe('terminal');
    expect(isLensHistoryEntry({})).toBe(false);
    expect(getHistoryModeDisplayText({})).toBe('Terminal');
    expect(getHistoryModeBadgeText({})).toBe('TRM');
  });

  it('keeps lens entries provider-specific', async () => {
    const {
      isLensHistoryEntry,
      getHistoryModeDisplayText,
      getHistoryModeBadgeText,
      resolveSessionHistoryMode,
    } =
      await import('./launchMode');

    expect(isLensHistoryEntry({ launchMode: 'lens', profile: 'claude' })).toBe(true);
    expect(getHistoryModeDisplayText({ launchMode: 'lens', profile: 'claude' })).toBe(
      'Lens · Claude',
    );
    expect(getHistoryModeBadgeText({ launchMode: 'lens', profile: 'claude' })).toBe('CLD');
    expect(getHistoryModeBadgeText({ launchMode: 'lens', profile: 'codex' })).toBe('CDX');
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

  it('prefers persisted surface type badges when present', async () => {
    const { getHistoryModeBadgeText, getHistoryModeDisplayText } = await import('./launchMode');

    expect(getHistoryModeBadgeText({ surfaceType: 'trm' })).toBe('TRM');
    expect(getHistoryModeBadgeText({ surfaceType: 'cdx' })).toBe('CDX');
    expect(getHistoryModeBadgeText({ surfaceType: 'cld' })).toBe('CLD');
    expect(getHistoryModeDisplayText({ surfaceType: 'cdx' })).toBe('Lens · Codex');
    expect(getHistoryModeDisplayText({ surfaceType: 'cld' })).toBe('Lens · Claude');
  });
});
