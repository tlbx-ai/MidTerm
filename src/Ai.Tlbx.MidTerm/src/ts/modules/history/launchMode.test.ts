import { describe, expect, it, vi } from 'vitest';

vi.mock('../i18n', () => ({
  t: (key: string) =>
    (
      ({
        'session.terminal': 'Terminal',
        'sessionTabs.agent': 'Agent',
        'sessionLauncher.codexTitle': 'Codex',
        'sessionLauncher.claudeTitle': 'Claude',
      }) as Record<string, string>
    )[key] ?? key,
}));

describe('history launch mode helpers', () => {
  it('defaults legacy entries to terminal mode', async () => {
    const {
      normalizeHistoryLaunchMode,
      isAppServerControlHistoryEntry,
      getHistoryModeDisplayText,
      getHistoryModeBadgeText,
    } = await import('./launchMode');

    expect(normalizeHistoryLaunchMode(undefined)).toBe('terminal');
    expect(isAppServerControlHistoryEntry({})).toBe(false);
    expect(getHistoryModeDisplayText({})).toBe('Terminal');
    expect(getHistoryModeBadgeText({})).toBe('TRM');
  });

  it('keeps appServerControl entries provider-specific', async () => {
    const {
      isAppServerControlHistoryEntry,
      getHistoryModeDisplayText,
      getHistoryModeBadgeText,
      resolveSessionHistoryMode,
    } = await import('./launchMode');

    expect(
      isAppServerControlHistoryEntry({ launchMode: 'appServerControl', profile: 'claude' }),
    ).toBe(true);
    expect(getHistoryModeDisplayText({ launchMode: 'appServerControl', profile: 'claude' })).toBe(
      'Agent · Claude',
    );
    expect(getHistoryModeBadgeText({ launchMode: 'appServerControl', profile: 'claude' })).toBe(
      'CLD',
    );
    expect(getHistoryModeBadgeText({ launchMode: 'appServerControl', profile: 'codex' })).toBe(
      'CDX',
    );
    expect(
      resolveSessionHistoryMode({
        appServerControlOnly: true,
        profileHint: 'codex',
      }),
    ).toEqual({
      launchMode: 'appServerControl',
      profile: 'codex',
    });
  });

  it('prefers persisted surface type badges when present', async () => {
    const { getHistoryModeBadgeText, getHistoryModeDisplayText } = await import('./launchMode');

    expect(getHistoryModeBadgeText({ surfaceType: 'trm' })).toBe('TRM');
    expect(getHistoryModeBadgeText({ surfaceType: 'cdx' })).toBe('CDX');
    expect(getHistoryModeBadgeText({ surfaceType: 'cld' })).toBe('CLD');
    expect(getHistoryModeDisplayText({ surfaceType: 'cdx' })).toBe('Agent · Codex');
    expect(getHistoryModeDisplayText({ surfaceType: 'cld' })).toBe('Agent · Claude');
  });
});
