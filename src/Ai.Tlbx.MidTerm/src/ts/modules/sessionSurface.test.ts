import { describe, expect, it, vi } from 'vitest';

vi.mock('./i18n', () => ({
  t: (key: string) =>
    (
      ({
        'session.terminal': 'Terminal',
        'sessionTabs.agent': 'Lens',
        'sessionLauncher.codexTitle': 'Codex',
        'sessionLauncher.claudeTitle': 'Claude',
      }) as Record<string, string>
    )[key] ?? key,
}));

describe('sessionSurface', () => {
  it('keeps regular shell sessions on the terminal surface', async () => {
    const { resolveSessionSurfaceMode, getPrimarySurfaceLabel } = await import('./sessionSurface');

    expect(
      resolveSessionSurfaceMode({
        lensOnly: false,
        agentControlled: false,
        hasLensHistory: false,
        supervisor: { profile: 'shell' },
      }),
    ).toBe('terminal');
    expect(getPrimarySurfaceLabel({ supervisor: { profile: 'shell' } })).toBe('Terminal');
  });

  it('uses provider-specific labels for codex and claude sessions', async () => {
    const { resolveSessionSurfaceMode, getPrimarySurfaceLabel } = await import('./sessionSurface');

    expect(
      resolveSessionSurfaceMode({
        lensOnly: true,
        supervisor: { profile: 'codex' },
      }),
    ).toBe('agent');
    expect(
      getPrimarySurfaceLabel({
        lensOnly: true,
        supervisor: { profile: 'codex' },
      }),
    ).toBe('Codex');
    expect(
      getPrimarySurfaceLabel({
        lensOnly: true,
        supervisor: { profile: 'claude' },
      }),
    ).toBe('Claude');
  });

  it('lets forced lens availability temporarily claim the primary surface', async () => {
    const { resolveSessionSurfaceMode } = await import('./sessionSurface');

    expect(
      resolveSessionSurfaceMode(
        {
          lensOnly: false,
          agentControlled: false,
          hasLensHistory: false,
          supervisor: { profile: 'shell' },
        },
        { lensForcedVisible: true },
      ),
    ).toBe('agent');
  });
});
