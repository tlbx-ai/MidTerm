import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const source = readFileSync(path.join(__dirname, 'bar.ts'), 'utf8');

describe('touch controller dock wiring', () => {
  it('lets the adaptive footer own visibility when the touch controller is embedded', () => {
    expect(source).toContain("controllerElement.classList.contains('embedded')");
    expect(source).toContain("controllerElement.classList.add(CSS_CLASSES.visible);");
    expect(source).toContain("controllerElement.classList.remove(CSS_CLASSES.visible);");
  });
});
