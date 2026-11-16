import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { constants as zlibConstants, createBrotliCompress, createGzip } from "node:zlib";
import {
  applyWebBaseUrlToIndexHtml,
  applyWebBaseUrlToManifest,
  normalizeWebBaseUrl,
} from "./web-base-url.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(REPO_ROOT, "packages", "app");
const SOURCE_DIST = path.join(APP_DIR, "dist");
const TARGET_DIST = path.join(REPO_ROOT, "packages", "server", "dist", "server", "web-ui");
const COMPRESS_EXTENSIONS = new Set([".html", ".js", ".css", ".json", ".svg", ".map"]);
// Optional URL path prefix the daemon serves the web UI under (PASEO_BASE_PATH on
// the daemon). Unset builds for the root.
const WEB_BASE_URL = normalizeWebBaseUrl(process.env.PASEO_WEB_BASE_URL);

function fmtMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      ...options,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed with exit code ${code}: ${command} ${args.join(" ")}`));
        return;
      }
      resolve();
    });
  });
}

async function exportBrowserWebApp() {
  console.log(
    WEB_BASE_URL
      ? `Exporting browser web app for base URL ${WEB_BASE_URL}...`
      : "Exporting browser web app...",
  );
  await run("npm", ["run", "build:web", "--workspace=@getpaseo/app"], {
    cwd: REPO_ROOT,
    env: { ...process.env, PASEO_WEB_BASE_URL: WEB_BASE_URL },
  });
}

async function applyWebBaseUrl() {
  if (!WEB_BASE_URL) {
    return;
  }
  const indexPath = path.join(TARGET_DIST, "index.html");
  const html = await readFile(indexPath, "utf8");
  await writeFile(indexPath, applyWebBaseUrlToIndexHtml(html, WEB_BASE_URL));
  const manifestPath = path.join(TARGET_DIST, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(
    manifestPath,
    `${JSON.stringify(applyWebBaseUrlToManifest(manifest, WEB_BASE_URL), null, 2)}\n`,
  );
}

async function cleanTarget() {
  console.log(`Cleaning ${path.relative(REPO_ROOT, TARGET_DIST)}...`);
  await rm(TARGET_DIST, { recursive: true, force: true });
  await mkdir(TARGET_DIST, { recursive: true });
}

async function copyAssets() {
  console.log(`Copying assets to ${path.relative(REPO_ROOT, TARGET_DIST)}...`);
  await cp(SOURCE_DIST, TARGET_DIST, { recursive: true, force: true });
}

async function compressFile(filePath) {
  const brotliPath = `${filePath}.br`;
  const gzipPath = `${filePath}.gz`;
  await Promise.all([
    pipeline(
      createReadStream(filePath),
      createBrotliCompress({
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
        },
      }),
      createWriteStream(brotliPath),
    ),
    pipeline(createReadStream(filePath), createGzip(), createWriteStream(gzipPath)),
  ]);
}

async function precompressAssets(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const dirs = entries.filter((entry) => entry.isDirectory());

  for (const file of files) {
    const filePath = path.join(dir, file.name);
    if (COMPRESS_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
      await compressFile(filePath);
    }
  }

  for (const subdir of dirs) {
    await precompressAssets(path.join(dir, subdir.name));
  }
}

async function measureBundle(dir) {
  let raw = 0;
  let gzip = 0;
  let brotli = 0;

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      const info = await stat(entryPath);
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".br") {
        brotli += info.size;
      } else if (ext === ".gz") {
        gzip += info.size;
      } else {
        raw += info.size;
      }
    }
  }

  await walk(dir);
  return { raw, gzip, brotli };
}

async function main() {
  await exportBrowserWebApp();

  const sourceStat = await stat(SOURCE_DIST).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    throw new Error(`Browser web export not found at ${SOURCE_DIST}`);
  }

  await cleanTarget();
  await copyAssets();
  await applyWebBaseUrl();
  await precompressAssets(TARGET_DIST);

  const sizes = await measureBundle(TARGET_DIST);
  console.log("Daemon web UI bundle:");
  console.log(`  raw:    ${fmtMiB(sizes.raw)}`);
  console.log(`  gzip:   ${fmtMiB(sizes.gzip)}`);
  console.log(`  brotli: ${fmtMiB(sizes.brotli)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
