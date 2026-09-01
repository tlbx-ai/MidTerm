import { build } from "esbuild";

await build({
  entryPoints: ["src/bridge.mjs"],
  outfile: "dist/claude-agent-sdk-bridge.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  minify: true,
  legalComments: "eof",
  sourcemap: false,
});
