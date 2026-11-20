import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

for (const directory of ["", "v2/"]) {
  const sourcePath = fileURLToPath(
    new URL(
      `../src/server/agent/providers/opencode/${directory}bridge-plugin.mjs`,
      import.meta.url,
    ),
  );
  const outputPath = fileURLToPath(
    new URL(
      `../dist/server/server/agent/providers/opencode/${directory}bridge-plugin.bundle.mjs`,
      import.meta.url,
    ),
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await build({
    entryPoints: [sourcePath],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
    outfile: outputPath,
  });
  if (directory === "v2/") {
    await copyFile(
      new URL("../src/server/agent/providers/opencode/v2/state.mjs", import.meta.url),
      path.join(path.dirname(outputPath), "state.mjs"),
    );
  }
}
