import { describe, expect, it } from 'vitest';
import type { HubMachineState } from '../hub/types';
import type { HubSessionLauncherTarget } from './index';

describe('session launcher target selection', () => {
  it('includes local plus launchable remote machines', async () => {
    const { buildSessionLauncherTargets } = await import('./index');

    const targets = buildSessionLauncherTargets([
      {
        machine: {
          id: 'm1',
          name: 'Build Box',
          baseUrl: 'https://build-box:2000',
          enabled: true,
          hasApiKey: true,
          hasPassword: false,
          lastFingerprint: null,
          pinnedFingerprint: null,
        },
        status: 'online',
        error: null,
        fingerprintMismatch: false,
        requiresTrust: false,
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        updateAvailable: false,
        sessions: [],
      },
    ]);

    expect(targets).toEqual([
      {
        id: 'local',
        kind: 'local',
      },
      {
        id: 'hub:m1',
        kind: 'hub',
        machineId: 'm1',
        machineName: 'Build Box',
        baseUrl: 'https://build-box:2000',
      },
    ]);
  });

  it('allows Lens providers locally but only Terminal remotely', async () => {
    const { isProviderSupportedOnTarget } = await import('./index');

    const remoteTarget: HubSessionLauncherTarget = {
      id: 'hub:m1',
      kind: 'hub',
      machineId: 'm1',
      machineName: 'Build Box',
      baseUrl: 'https://build-box:2000',
    };

    expect(isProviderSupportedOnTarget('terminal', { id: 'local', kind: 'local' })).toBe(true);
    expect(isProviderSupportedOnTarget('codex', { id: 'local', kind: 'local' })).toBe(true);
    expect(isProviderSupportedOnTarget('claude', { id: 'local', kind: 'local' })).toBe(true);

    expect(isProviderSupportedOnTarget('terminal', remoteTarget)).toBe(true);
    expect(isProviderSupportedOnTarget('codex', remoteTarget)).toBe(false);
    expect(isProviderSupportedOnTarget('claude', remoteTarget)).toBe(false);
  });

  it('swaps the local picker and remote path field visibility by target type', async () => {
    const { syncLocationPickerVisibility } = await import('./index');

    const localBrowser = { hidden: true };
    const remoteBrowser = { hidden: false };

    const isLocal = syncLocationPickerVisibility(
      { id: 'local', kind: 'local' },
      { localBrowser, remoteBrowser },
    );

    expect(isLocal).toBe(true);
    expect(localBrowser.hidden).toBe(false);
    expect(remoteBrowser.hidden).toBe(true);

    const remoteTarget: HubSessionLauncherTarget = {
      id: 'hub:m1',
      kind: 'hub',
      machineId: 'm1',
      machineName: 'Build Box',
      baseUrl: 'https://build-box:2000',
    };

    const isRemote = syncLocationPickerVisibility(remoteTarget, {
      localBrowser,
      remoteBrowser,
    });

    expect(isRemote).toBe(false);
    expect(localBrowser.hidden).toBe(true);
    expect(remoteBrowser.hidden).toBe(false);
  });
});
