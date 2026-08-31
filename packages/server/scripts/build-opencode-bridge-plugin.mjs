import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const sourcePath = fileURLToPath(
  new URL("../src/server/agent/providers/opencode/bridge-plugin.mjs", import.meta.url),
);
const outputPath = fileURLToPath(
  new URL(
    "../dist/server/server/agent/providers/opencode/bridge-plugin.bundle.mjs",
    import.meta.url,
  ),
);

await mkdir(path.dirname(outputPath), { recursive: true });
await build({
  entryPoints: [sourcePath],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: outputPath,
});
