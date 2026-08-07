/**
 * Regression check: dragging a node re-renders edges every pointermove —
 * the SVG layer must not accumulate stale paths (the v10.2.2 hairball).
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1920, height: 1080 }, video: 'off', launchOptions: { slowMo: 0 } });

test('dragging keeps the edge layer clean', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#btn-action-graphs', { state: 'attached', timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    document.getElementById('btn-action-graphs')?.click();
  });
  await page.waitForSelector('#action-graphs-nodes .ag-node', { timeout: 15000 });
  await page.waitForTimeout(500);

  const card = page.locator('.ag-node[data-node-id="proj-tlbx"]');
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 25; step++) {
    await page.mouse.move(box.x + box.width / 2 + step * 4, box.y + box.height / 2 + step * 2);
  }
  const childCountDuringDrag = await page.evaluate(
    () => document.getElementById('action-graphs-edges')?.childElementCount ?? -1,
  );
  await page.mouse.up();

  // One render pass = defs + one path per edge + labels (~30 for the seeded board).
  expect(childCountDuringDrag).toBeGreaterThan(0);
  expect(childCountDuringDrag).toBeLessThan(60);
});
