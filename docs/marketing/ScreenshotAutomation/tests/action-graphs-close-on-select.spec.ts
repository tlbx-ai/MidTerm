/**
 * Regression check: selecting a session from the sidebar closes the Action Graphs
 * view and returns to the terminal. Requires at least one session on the target
 * instance (created by the runner before the test).
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1920, height: 1080 }, video: 'off', launchOptions: { slowMo: 0 } });

test('sidebar session click closes the action graphs view', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#btn-action-graphs', { state: 'attached', timeout: 20000 });
  await page.waitForSelector('.session-item[data-session-id]', { timeout: 20000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => {
    document.getElementById('btn-action-graphs')?.click();
  });
  await page.waitForSelector('#action-graphs-view:not(.hidden)', { timeout: 10000 });

  await page.locator('.session-item[data-session-id]').first().click();
  await page.waitForTimeout(400);

  const hidden = await page.evaluate(
    () => document.getElementById('action-graphs-view')?.classList.contains('hidden') ?? false,
  );
  expect(hidden).toBe(true);
});
