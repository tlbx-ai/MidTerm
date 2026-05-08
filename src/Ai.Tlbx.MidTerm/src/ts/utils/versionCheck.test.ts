import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getVersion: vi.fn(),
  getVersionDetails: vi.fn(),
  setFrontendRefreshState: vi.fn(),
  clearFrontendRefreshState: vi.fn(),
  requestFrontendRefresh: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../constants', () => ({
  JS_BUILD_VERSION: '1.0.0',
  MUX_PROTOCOL_VERSION: 1,
}));

vi.mock('../modules/logging', () => ({
  createLogger: () => ({
    info: vi.fn(),
  }),
}));

vi.mock('../api/client', () => ({
  getVersion: mocks.getVersion,
  getVersionDetails: mocks.getVersionDetails,
}));

vi.mock('../modules/updating/runtime', () => ({
  setFrontendRefreshState: mocks.setFrontendRefreshState,
  clearFrontendRefreshState: mocks.clearFrontendRefreshState,
  requestFrontendRefresh: mocks.requestFrontendRefresh,
}));

describe('versionCheck', () => {
  const setCurrentAssetVersion = (version: string | null): void => {
    vi.stubGlobal('window', { location: { href: 'https://127.0.0.1:2100/' } });
    vi.stubGlobal('document', {
      querySelector: vi.fn((selector: string) => {
        if (selector !== 'script[src*="/js/terminal.min.js"]' || !version) {
          return null;
        }

        return {
          getAttribute: vi.fn((name: string) => (name === 'src' ? `/js/terminal.min.js?v=${version}` : null)),
        };
      }),
    });
  };

  beforeEach(() => {
    vi.resetModules();
    Object.values(mocks).forEach((mock) => mock.mockReset());
    vi.stubGlobal('fetch', mocks.fetch);
    setCurrentAssetVersion(null);
  });

  it('clears pending refresh state when the server version matches the client', async () => {
    mocks.getVersion.mockResolvedValue({
      data: '1.0.0',
      response: { ok: true },
    });
    mocks.getVersionDetails.mockResolvedValue({ data: { protocol: 1, webOnly: true } });

    const { checkVersionAndReload } = await import('./versionCheck');
    const reloadRequested = await checkVersionAndReload();

    expect(reloadRequested).toBe(false);
    expect(mocks.clearFrontendRefreshState).toHaveBeenCalledTimes(1);
    expect(mocks.setFrontendRefreshState).not.toHaveBeenCalled();
    expect(mocks.requestFrontendRefresh).not.toHaveBeenCalled();
  });

  it('marks a compatible mismatch as a deferred refresh', async () => {
    mocks.getVersion.mockResolvedValue({
      data: '1.1.0',
      response: { ok: true },
    });
    mocks.getVersionDetails.mockResolvedValue({ data: { protocol: 1, webOnly: true } });

    const { checkVersionAndReload } = await import('./versionCheck');
    const reloadRequested = await checkVersionAndReload();

    expect(reloadRequested).toBe(false);
    expect(mocks.setFrontendRefreshState).toHaveBeenCalledWith('1.1.0', {
      status: 'available',
      updateType: 'webOnly',
    });
    expect(mocks.requestFrontendRefresh).not.toHaveBeenCalled();
  });

  it('forces reload on a compatible mismatch when the caller requires a current shell', async () => {
    mocks.getVersion.mockResolvedValue({
      data: '1.1.0',
      response: { ok: true },
    });
    mocks.getVersionDetails.mockResolvedValue({ data: { protocol: 1, webOnly: true } });

    const { checkVersionAndReload } = await import('./versionCheck');
    const reloadRequested = await checkVersionAndReload({ forceReloadOnMismatch: true });

    expect(reloadRequested).toBe(true);
    expect(mocks.setFrontendRefreshState).toHaveBeenCalledWith('1.1.0', {
      status: 'available',
      updateType: 'webOnly',
    });
    expect(mocks.requestFrontendRefresh).toHaveBeenCalledTimes(1);
  });

  it('reruns with force when a browser command arrives during a non-forcing check', async () => {
    let resolveFirstVersion!: (value: { data: string; response: { ok: boolean } }) => void;
    const firstVersion = new Promise<{ data: string; response: { ok: boolean } }>((resolve) => {
      resolveFirstVersion = resolve;
    });

    mocks.getVersion
      .mockReturnValueOnce(firstVersion)
      .mockResolvedValueOnce({ data: '1.1.0', response: { ok: true } });
    mocks.getVersionDetails.mockResolvedValue({ data: { protocol: 1, webOnly: true } });

    const { checkVersionAndReload } = await import('./versionCheck');
    const nonForcingCheck = checkVersionAndReload();
    const forcingCheck = checkVersionAndReload({ forceReloadOnMismatch: true });

    resolveFirstVersion({ data: '1.1.0', response: { ok: true } });

    await expect(nonForcingCheck).resolves.toBe(false);
    await expect(forcingCheck).resolves.toBe(true);
    expect(mocks.getVersion).toHaveBeenCalledTimes(2);
    expect(mocks.requestFrontendRefresh).toHaveBeenCalledTimes(1);
  });

  it('forces a refresh when the live mux protocol is no longer compatible', async () => {
    mocks.getVersion.mockResolvedValue({
      data: '2.0.0',
      response: { ok: true },
    });
    mocks.getVersionDetails.mockResolvedValue({ data: { protocol: 2, webOnly: false } });

    const { checkVersionAndReload } = await import('./versionCheck');
    const reloadRequested = await checkVersionAndReload();

    expect(reloadRequested).toBe(true);
    expect(mocks.setFrontendRefreshState).toHaveBeenCalledWith('2.0.0', {
      status: 'required',
      updateType: 'unknown',
    });
    expect(mocks.requestFrontendRefresh).toHaveBeenCalledTimes(1);
  });

  it('uses source-dev asset versions instead of server version strings', async () => {
    setCurrentAssetVersion('dev-123');
    mocks.fetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(
        '<!doctype html><script src="/js/terminal.min.js?v=dev-123"></script>',
      ),
    });

    const { checkVersionAndReload } = await import('./versionCheck');
    const reloadRequested = await checkVersionAndReload();

    expect(reloadRequested).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledWith('/index.html', { cache: 'no-store' });
    expect(mocks.clearFrontendRefreshState).toHaveBeenCalledTimes(1);
    expect(mocks.setFrontendRefreshState).not.toHaveBeenCalled();
    expect(mocks.requestFrontendRefresh).not.toHaveBeenCalled();
  });

  it('forces a refresh when source-dev asset stamps diverge after reconnect', async () => {
    setCurrentAssetVersion('dev-123');
    mocks.fetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(
        '<!doctype html><script src="/js/terminal.min.js?v=dev-456"></script>',
      ),
    });

    const { checkVersionAndReload } = await import('./versionCheck');
    const reloadRequested = await checkVersionAndReload();

    expect(reloadRequested).toBe(true);
    expect(mocks.requestFrontendRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.clearFrontendRefreshState).not.toHaveBeenCalled();
    expect(mocks.setFrontendRefreshState).not.toHaveBeenCalled();
  });
});
