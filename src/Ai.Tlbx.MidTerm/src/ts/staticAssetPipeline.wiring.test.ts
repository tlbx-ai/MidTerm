import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const frontendBuildSource = readFileSync(path.join(projectRoot, 'frontend-build.ps1'), 'utf8');
const projectSource = readFileSync(path.join(projectRoot, 'Ai.Tlbx.MidTerm.csproj'), 'utf8');
const compressedStaticFilesSource = readFileSync(
  path.join(projectRoot, 'Services/StaticFiles/CompressedStaticFilesMiddleware.cs'),
  'utf8',
);
const indexHtml = readFileSync(path.join(projectRoot, 'src/static/index.html'), 'utf8');

describe('static asset pipeline wiring', () => {
  it('copies and serves SVG image assets used by app chrome', () => {
    expect(indexHtml).toContain('/img/Midterm_exp.svg?v=__MIDTERM_ASSET_VERSION__');
    expect(frontendBuildSource).toContain('Get-ChildItem -Path "$imageSource\\*.svg"');
    expect(frontendBuildSource).toContain('img/$($_.Name) -> img/$($_.Name).br');
    expect(projectSource).toContain('<EmbeddedResource Include="wwwroot\\**\\*.br" />');
    expect(compressedStaticFilesSource).toContain('[".svg"] = "image/svg+xml"');
  });
});
