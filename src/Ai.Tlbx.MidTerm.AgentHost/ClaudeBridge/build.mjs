import { build } from "esbuild";
import { readFileSync } from "node:fs";

const sdkVersion = JSON.parse(
  readFileSync(
    new URL(
      "./node_modules/@anthropic-ai/claude-agent-sdk/package.json",
      import.meta.url,
    ),
    "utf8",
  ),
).version;

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
  define: { __CLAUDE_AGENT_SDK_VERSION__: JSON.stringify(sdkVersion) },
});
