import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const source = readFileSync(path.join(__dirname, 'webDock.ts'), 'utf8');

describe('web dock footer spacing wiring', () => {
  it('pushes the adaptive footer dock left when right-side docks are visible', () => {
    expect(source).toContain("const footerDock = document.getElementById('adaptive-footer-dock');");
    expect(source).toContain("footerDock.style.right = total > 0 ? `${total}px` : '';");
    expect(source).toContain("const managerQueue = document.getElementById('manager-bar-queue');");
    expect(source).toContain("managerQueue.style.marginRight = total > 0 ? `${total}px` : '';");
  });
});
