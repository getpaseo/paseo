import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { precompressAssets } from "./precompress-assets.mjs";

async function exists(filePath) {
  return stat(filePath).then(
    () => true,
    () => false,
  );
}

async function withDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "precompress-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("writes .br and .gz that decompress to the original, recursing into subdirectories", async () => {
  await withDir(async (dir) => {
    const body = "console.log('hello');\n".repeat(500);
    await mkdir(path.join(dir, "_expo", "static"), { recursive: true });
    const nested = path.join(dir, "_expo", "static", "index.js");
    await writeFile(nested, body);

    await precompressAssets(dir, { brotliQuality: 4 });

    assert.equal(brotliDecompressSync(await readFile(`${nested}.br`)).toString(), body);
    assert.equal(gunzipSync(await readFile(`${nested}.gz`)).toString(), body);
    assert.ok((await stat(`${nested}.br`)).size < body.length);
  });
});

test("skips extensions outside the compressible list", async () => {
  await withDir(async (dir) => {
    const png = path.join(dir, "logo.png");
    await writeFile(png, Buffer.alloc(2048, 1));
    await writeFile(path.join(dir, "app.css"), "a{color:red}");

    await precompressAssets(dir, { brotliQuality: 4 });

    assert.equal(await exists(`${png}.br`), false);
    assert.equal(await exists(`${png}.gz`), false);
    assert.equal(await exists(path.join(dir, "app.css.br")), true);
  });
});

test("is idempotent and never compresses its own output", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "index.html");
    const body = "<html></html>".repeat(100);
    await writeFile(file, body);

    await precompressAssets(dir, { brotliQuality: 4 });
    await precompressAssets(dir, { brotliQuality: 4 });

    assert.equal(await exists(`${file}.br.br`), false);
    assert.equal(await exists(`${file}.gz.gz`), false);
    assert.equal(brotliDecompressSync(await readFile(`${file}.br`)).toString(), body);
  });
});
