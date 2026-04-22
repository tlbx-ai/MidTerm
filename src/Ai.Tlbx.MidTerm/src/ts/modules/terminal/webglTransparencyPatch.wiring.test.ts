import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = path.join(__dirname, '../../../..');
const webglPatch = readFileSync(
  path.join(projectRoot, 'patches/@xterm+addon-webgl+0.19.0.patch'),
  'utf8',
);
const managerSource = readFileSync(path.join(__dirname, 'manager.ts'), 'utf8');

describe('WebGL transparency vendor patch', () => {
  it('keeps screenshot-readable WebGL while replacing stale transparent frames', () => {
    expect(managerSource).toContain('new WebglAddon(true)');
    expect(webglPatch).toContain('alpha: true');
    expect(webglPatch).toContain('premultipliedAlpha: true');
    expect(webglPatch).toContain('this._clearFrame();');
    expect(webglPatch).toContain('gl.clearColor(0, 0, 0, 0);');
    expect(webglPatch).toContain('gl.disable(gl.BLEND);');
    expect(webglPatch).toContain('old glyph pixels decay across cursor-blink redraws');
  });

  it('premultiplies transparent rectangle colors for Chrome canvas compositing', () => {
    expect(webglPatch).toContain(
      'outColor = vec4(v_color.rgb * v_color.a, v_color.a);',
    );
  });

  it('keeps transparent glyph atlas edges alpha-correct over transparent cells', () => {
    expect(webglPatch).toContain(
      'gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);',
    );
    expect(webglPatch).toContain(
      'Preserve glyph edge alpha when compositing over transparent cell backgrounds.',
    );
    expect(webglPatch).not.toContain('shouldClearOpaqueRasterBackground');
    expect(webglPatch).not.toContain('Transparent canvas text rasterization breaks font smoothing');
  });
});
