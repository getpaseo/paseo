import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep the large upstream binaries out of Git while reproducing the exact licensed bundle.
export async function ensureDocumentFonts(directory) {
  const root = fileURLToPath(directory);
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  for (const entry of manifest) {
    if (!/^[A-Za-z0-9-]+\.(otf|ttf|txt)$/.test(entry.file)) {
      throw new Error("Invalid document font filename");
    }
    const target = path.join(root, entry.file);
    let bytes = await readFile(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    const missing = bytes === null;
    if (missing) {
      const url = new URL(entry.url);
      if (url.protocol !== "https:" || url.hostname !== "raw.githubusercontent.com") {
        throw new Error(`Unexpected document font source: ${entry.file}`);
      }
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Document font download failed: ${entry.file}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (
      bytes.length !== entry.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    ) {
      throw new Error(`Document font checksum mismatch: ${entry.file}`);
    }
    if (missing) {
      const temporary = `${target}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, bytes, { flag: "wx" });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
}
