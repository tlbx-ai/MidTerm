import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applyUpdate: vi.fn(),
  showConfirm: vi.fn(),
  showAlert: vi.fn(),
  beginServerRestartLifecycle: vi.fn(),
}));

vi.mock('../../api/client', () => ({ ...mocks }));
vi.mock('../../utils/dialog', () => ({ ...mocks }));
vi.mock('../../utils', () => ({ escapeHtml: (value: string) => value }));
vi.mock('../logging', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('../i18n', () => ({ t: (key: string) => key }));
vi.mock('../settings', () => ({}));
vi.mock('../navigation/backButtonGuard', () => ({}));
vi.mock('./runtime', () => ({ ...mocks }));

import { $updateInfo } from '../../stores';
import { applyFullUpdate } from './checker';

describe('full update action', () => {
  const button = { disabled: false, textContent: '' };

  beforeEach(() => {
    vi.clearAllMocks();
    button.disabled = false;
    $updateInfo.set(null);
    vi.stubGlobal('document', { getElementById: () => button });
    vi.stubGlobal('localStorage', { setItem: vi.fn() });
    mocks.showConfirm.mockResolvedValue(true);
    mocks.applyUpdate.mockResolvedValue({ response: { ok: true } });
  });

  it('can reinstall when no newer update is available', async () => {
    await applyFullUpdate();
    expect(mocks.showConfirm).toHaveBeenCalledWith('update.fullUpdateConfirm', expect.any(Object));
    expect(mocks.applyUpdate).toHaveBeenCalledWith(undefined, true);
    expect(mocks.beginServerRestartLifecycle).toHaveBeenCalledWith('update', {
      updateType: 'full',
      expectedServerVersion: null,
    });
  });

  it('does not start an update when confirmation is cancelled', async () => {
    mocks.showConfirm.mockResolvedValue(false);
    await applyFullUpdate();
    expect(mocks.applyUpdate).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
  });

  it('shows the server failure and allows retry without announcing a restart', async () => {
    mocks.applyUpdate.mockResolvedValue({
      response: { ok: false, text: async () => 'Download failed' },
    });
    await applyFullUpdate();
    expect(mocks.showAlert).toHaveBeenCalledWith('update.failed', {
      details: 'Error: Download failed',
    });
    expect(mocks.beginServerRestartLifecycle).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
  });
});
