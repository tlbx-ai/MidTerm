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
      isAppServerControlHistoryEntry({ launchMode: 'appServerControl', profile: 'opencode' }),
    ).toBe(true);
    expect(getHistoryModeDisplayText({ launchMode: 'appServerControl', profile: 'opencode' })).toBe(
      'Agent · OpenCode',
    );
    expect(getHistoryModeBadgeText({ launchMode: 'appServerControl', profile: 'opencode' })).toBe(
      'OPC',
    );
    expect(
      isAppServerControlHistoryEntry({ launchMode: 'appServerControl', profile: 'claude' }),
    ).toBe(false);
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
    expect(getHistoryModeBadgeText({ surfaceType: 'acp', profile: 'opencode' })).toBe('OPC');
    expect(getHistoryModeDisplayText({ surfaceType: 'cdx' })).toBe('Agent · Codex');
    expect(getHistoryModeDisplayText({ surfaceType: 'cld' })).toBe('Agent · Claude');
  });

  it('keeps dynamically discovered ACP profiles bookmarkable', async () => {
    const { getBookmarkSurfaceType } = await import('./bookmarkSession');
    const { resolveSessionHistoryMode } = await import('./launchMode');
    const session = {
      id: 'session-opencode',
      appServerControlOnly: true,
      profileHint: 'opencode',
    } as never;

    const mode = resolveSessionHistoryMode(session);
    expect(mode).toEqual({ launchMode: 'appServerControl', profile: 'opencode' });
    expect(getBookmarkSurfaceType(session, mode.profile)).toBe('acp');
  });
});
