import { build } from 'esbuild';
import path from 'node:path';

const frontendRoot = process.cwd();
const xtermRoot = path.join(frontendRoot, 'node_modules', '@xterm', 'xterm');
const webglRoot = path.join(frontendRoot, 'node_modules', '@xterm', 'addon-webgl');

const aliases = {
  browser: path.join(xtermRoot, 'src', 'browser'),
  common: path.join(xtermRoot, 'src', 'common'),
};

const bundles = [
  {
    entryPoint: path.join(xtermRoot, 'src', 'browser', 'public', 'Terminal.ts'),
    outputs: [
      ['esm', path.join(xtermRoot, 'lib', 'xterm.mjs')],
      ['cjs', path.join(xtermRoot, 'lib', 'xterm.js')],
    ],
  },
  {
    entryPoint: path.join(webglRoot, 'src', 'WebglAddon.ts'),
    external: ['@xterm/xterm'],
    outputs: [
      ['esm', path.join(webglRoot, 'lib', 'addon-webgl.mjs')],
      ['cjs', path.join(webglRoot, 'lib', 'addon-webgl.js')],
    ],
  },
];

for (const bundle of bundles) {
  for (const [format, outfile] of bundle.outputs) {
    await build({
      alias: aliases,
      bundle: true,
      entryPoints: [bundle.entryPoint],
      external: bundle.external,
      format,
      legalComments: 'eof',
      minify: true,
      outfile,
      platform: 'browser',
      sourcemap: false,
      target: 'es2020',
      tsconfigRaw: {
        compilerOptions: {
          experimentalDecorators: true,
          useDefineForClassFields: false,
        },
      },
    });
  }
}
