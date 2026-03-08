import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const html = readFileSync(
  path.join(repoRoot, 'src/Ai.Tlbx.MidTerm/src/static/index.html'),
  'utf8',
);
const persistenceSource = readFileSync(
  path.join(repoRoot, 'src/Ai.Tlbx.MidTerm/src/ts/modules/settings/persistence.ts'),
  'utf8',
);

const NON_PERSISTED_SETTING_IDS = new Set([
  'setting-background-upload',
  'setting-ui-transparency-value',
]);

function getPersistedSettingIds(): string[] {
  const ids = new Set<string>();

  for (const match of html.matchAll(/id="(setting-[^"]+)"/g)) {
    const id = match[1];
    if (!id || NON_PERSISTED_SETTING_IDS.has(id)) {
      continue;
    }

    ids.add(id);
  }

  return [...ids].sort();
}

describe('settings persistence wiring', () => {
  it('references every persisted settings control from index.html', () => {
    const missing = getPersistedSettingIds().filter((id) => !persistenceSource.includes(`'${id}'`));
    expect(missing).toEqual([]);
  });

  it('auto-saves text and number settings on change', () => {
    expect(persistenceSource).toContain('input[type="text"], input[type="number"]');
  });
});
