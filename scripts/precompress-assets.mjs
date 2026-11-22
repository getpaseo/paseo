import { createReadStream, createWriteStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createBrotliCompress, createGzip } from "node:zlib";
import { isMainModule } from "./is-main-module.mjs";

// The daemon web server (packages/server/src/server/web-ui.ts) serves `<asset>.br` / `<asset>.gz`
// beside an asset when the client sends Accept-Encoding. Both the standalone daemon web UI and the
// desktop app's app-dist run this over the web export before it is packaged.
export const COMPRESS_EXTENSIONS = new Set([".html", ".js", ".css", ".json", ".svg", ".map"]);

export async function compressFile(filePath, { brotliQuality } = {}) {
  await Promise.all([
    pipeline(
      createReadStream(filePath),
      createBrotliCompress({
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: brotliQuality ?? zlibConstants.BROTLI_MAX_QUALITY,
        },
      }),
      createWriteStream(`${filePath}.br`),
    ),
    pipeline(createReadStream(filePath), createGzip(), createWriteStream(`${filePath}.gz`)),
  ]);
}

export async function precompressAssets(dir, options = {}) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await precompressAssets(entryPath, options);
    } else if (entry.isFile() && COMPRESS_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      await compressFile(entryPath, options);
    }
  }
}

if (isMainModule(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: node scripts/precompress-assets.mjs <dir>");
    process.exit(2);
  }
  const started = Date.now();
  try {
    await precompressAssets(path.resolve(dir));
    console.log(`Precompressed ${dir} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
