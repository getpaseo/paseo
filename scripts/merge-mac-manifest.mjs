import fs from "node:fs";
import { dump, load } from "js-yaml";

export function mergeMacManifest(arm64Path, x64Path, outputPath) {
  const arm64 = load(fs.readFileSync(arm64Path, "utf8"));
  const x64 = load(fs.readFileSync(x64Path, "utf8"));
  const files = [...(arm64.files ?? []), ...(x64.files ?? [])].filter(
    (file, index, all) => all.findIndex((entry) => entry.url === file.url) === index,
  );
  const output = dump({ ...arm64, files }, { lineWidth: -1, noRefs: true });
  fs.writeFileSync(outputPath, output);
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , arm64Path, x64Path, outputPath] = process.argv;
  if (!arm64Path || !x64Path || !outputPath) {
    throw new Error("Usage: node scripts/merge-mac-manifest.mjs <arm64.yml> <x64.yml> <out.yml>");
  }
  process.stdout.write(mergeMacManifest(arm64Path, x64Path, outputPath));
}
