/**
 * Stills of the Action Graphs canvas for visual-style iteration.
 * Target instance comes from MIDTERM_BASE_URL; the board must already be seeded.
 * Output: output/action-graphs/<name>.png
 */
import { test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT_DIR = path.join(__dirname, '..', 'output', 'action-graphs');

test.use({
  viewport: { width: 1920, height: 1080 },
  video: 'off',
  launchOptions: { slowMo: 0 },
});

async function fitStage(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const stage = document.getElementById('action-graphs-stage');
    const canvas = document.getElementById('action-graphs-canvas');
    const nodes = document.querySelectorAll<HTMLElement>('#action-graphs-nodes .ag-node');
    if (!stage || !canvas || nodes.length === 0) return;
    let maxX = 0;
    let maxY = 0;
    for (const node of nodes) {
      maxX = Math.max(maxX, node.offsetLeft + node.offsetWidth);
      maxY = Math.max(maxY, node.offsetTop + node.offsetHeight);
    }
    const pad = 48;
    const scale = Math.min(
      (canvas.clientWidth - pad) / (maxX + pad),
      (canvas.clientHeight - pad) / (maxY + pad),
      1,
    );
    stage.style.transform = `translate(${pad * scale}px, ${pad * scale}px) scale(${scale})`;
  });
  await page.waitForTimeout(300);
}

test('action graphs stills', async ({ page }) => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await page.goto('/');
  await page.waitForSelector('#btn-action-graphs', { state: 'attached', timeout: 20000 });
  await page.waitForTimeout(1500);

  await page.evaluate(() => {
    document.getElementById('btn-action-graphs')?.click();
  });
  await page.waitForSelector('#action-graphs-view:not(.hidden)', { timeout: 10000 });
  await page.waitForSelector('#action-graphs-nodes .ag-node', { timeout: 15000 });
  await page.waitForTimeout(800);

  await fitStage(page);
  await page.screenshot({ path: path.join(OUT_DIR, 'board-overview.png') });

  // Detail panel: select a project node with actions + html body
  await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.ag-node[data-node-id="proj-tlbx"]');
    card?.click();
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT_DIR, 'board-detail.png') });

  // Editor
  await page.evaluate(() => {
    document.getElementById('ag-new-node')?.click();
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT_DIR, 'board-editor.png') });
});
