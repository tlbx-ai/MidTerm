import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getVersion: vi.fn(),
  getVersionDetails: vi.fn(),
  setFrontendRefreshState: vi.fn(),
  clearFrontendRefreshState: vi.fn(),
  requestFrontendRefresh: vi.fn(),
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
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it('clears pending refresh state when the server version matches the client', async () => {
    mocks.getVersion.mockResolvedValue({
      data: '1.0.0',
      response: { ok: true },
    });
    mocks.getVersionDetails.mockResolvedValue({ data: { protocol: 1, webOnly: true } });

    const { checkVersionAndReload } = await import('./versionCheck');
    await checkVersionAndReload();

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
    await checkVersionAndReload();

    expect(mocks.setFrontendRefreshState).toHaveBeenCalledWith('1.1.0', {
      status: 'available',
      updateType: 'webOnly',
    });
    expect(mocks.requestFrontendRefresh).not.toHaveBeenCalled();
  });

  it('forces a refresh when the live mux protocol is no longer compatible', async () => {
    mocks.getVersion.mockResolvedValue({
      data: '2.0.0',
      response: { ok: true },
    });
    mocks.getVersionDetails.mockResolvedValue({ data: { protocol: 2, webOnly: false } });

    const { checkVersionAndReload } = await import('./versionCheck');
    await checkVersionAndReload();

    expect(mocks.setFrontendRefreshState).toHaveBeenCalledWith('2.0.0', {
      status: 'required',
      updateType: 'unknown',
    });
    expect(mocks.requestFrontendRefresh).toHaveBeenCalledTimes(1);
  });
});
