// A standalone entrypoint also works outside Electron's ASAR without dependency resolution.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await build({
  entryPoints: [
    fileURLToPath(new URL("../src/server/agent/mcp-unix-bridge-cli.ts", import.meta.url)),
  ],
  outfile: fileURLToPath(
    new URL("../dist/server/server/agent/mcp-unix-bridge-cli.mjs", import.meta.url),
  ),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
});
