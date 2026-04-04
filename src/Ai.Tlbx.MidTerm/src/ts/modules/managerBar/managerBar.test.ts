import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { shouldShowManagerBar } from './visibility';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../../..');
const managerBarSource = readFileSync(
  path.join(projectRoot, 'src/ts/modules/managerBar/managerBar.ts'),
  'utf8',
);

describe('manager bar visibility', () => {
  it('stays hidden when there is no active session', () => {
    expect(shouldShowManagerBar(true, null)).toBe(false);
  });

  it('shows only when enabled and a session is active', () => {
    expect(shouldShowManagerBar(true, 'session-1')).toBe(true);
    expect(shouldShowManagerBar(false, 'session-1')).toBe(false);
  });

  it('keeps the full button body as the primary click target', () => {
    expect(managerBarSource).toContain("const button = target.closest<HTMLElement>('.manager-btn');");
    expect(managerBarSource).not.toContain("const labelEl = target.closest('.manager-btn-label');");
  });

  it('uses a compact menu trigger before showing edit and remove actions', () => {
    expect(managerBarSource).toContain("class=\"manager-btn-menu\"");
    expect(managerBarSource).toContain("button.classList.toggle('menu-open', shouldOpen);");
    expect(managerBarSource).toContain("if (target.closest('.manager-btn-actions')) {");
  });

  it('guards burst enqueue clicks before sending duplicate queue requests', () => {
    expect(managerBarSource).toContain('const QUEUE_ENQUEUE_DEDUP_WINDOW_MS = 1500;');
    expect(managerBarSource).toContain('const pendingEnqueueGuards = new Map<string, number>();');
    expect(managerBarSource).toContain('const enqueueGuardKey = buildEnqueueGuardKey(sessionId, action);');
  });

  it('uses a direct queue cancel handler with optimistic removal state', () => {
    expect(managerBarSource).toContain('const pendingQueueRemovals = new Set<string>();');
    expect(managerBarSource).toContain("deleteBtn.addEventListener('click', (event) => {");
    expect(managerBarSource).toContain('pendingQueueRemovals.add(queueId);');
  });
});
