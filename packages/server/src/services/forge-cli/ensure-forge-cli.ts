import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pino from "pino";

import { probeExecutable } from "../../executable-resolution/executable-resolution.js";
import { spawnProcess } from "../../utils/spawn.js";
import { getForgeCliChecksum, resolveForgeCliAsset, type ForgeCliId } from "./forge-cli-catalog.js";

export interface EnsureForgeCliOptions {
  paseoHome: string;
  logger: pino.Logger;
  /** Root dir for downloaded tools. Defaults to `<paseoHome>/tools`. */
  toolsDir?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the real `--version` probe. */
  probeExecutableImpl?: (executablePath: string) => Promise<boolean>;
  /** Injectable for tests; defaults to the real forge-cli-versions.json lookup. */
  getForgeCliChecksumImpl?: (cli: ForgeCliId, assetFilename: string) => string | null;
  /** Injectable for tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Injectable for tests; defaults to process.arch. */
  arch?: string;
}

const EXECUTABLE_MODE = 0o755;

function toolsDirFor(options: EnsureForgeCliOptions): string {
  return options.toolsDir ?? path.join(options.paseoHome, "tools");
}

function managedCliPath(options: EnsureForgeCliOptions, cli: ForgeCliId): string {
  return path.join(toolsDirFor(options), cli, cli);
}

async function downloadToFile(
  fetchImpl: typeof fetch,
  url: string,
  outputPath: string,
): Promise<void> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error(`Failed to download ${url}: missing response body`);
  }

  // randomUUID, not Date.now(). Two installs racing on the same shared
  // PASEO_TOOLS_DIR (e.g. two daemons) could land in the same millisecond.
  const tmpPath = `${outputPath}.tmp-${randomUUID()}`;
  await mkdir(path.dirname(outputPath), { recursive: true });

  // The fetch ReadableStream type is slightly different from what Readable.fromWeb expects
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeStream = Readable.fromWeb(res.body as any);

  try {
    await pipeline(nodeStream, createWriteStream(tmpPath));
    await rename(tmpPath, outputPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function extractTarArchive(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess("tar", ["xf", archivePath, "-C", destDir], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}`));
    });
  });
}

// Downloads gh/glab/tea into $PASEO_HOME/tools/<cli>/<cli> when it's missing
// from PATH. Only meant for the Docker image, where we control the base and
// know it's linux. forge-cli-catalog.ts only has assets for linux, so
// darwin/win32 just no-op below. Not something we want to do on someone's
// actual mac or dev box.
//
// Shape is fetch -> tmp file -> atomic rename -> extract -> chmod -> probe,
// same idea as the sherpa ONNX model downloader. Every failure (bad
// platform, download error, probe failure) just resolves to null and logs,
// never throws the daemon down.
const inFlightByCli = new Map<ForgeCliId, Promise<string | null>>();

export function ensureForgeCli(
  cli: ForgeCliId,
  options: EnsureForgeCliOptions,
): Promise<string | null> {
  const existing = inFlightByCli.get(cli);
  if (existing) {
    return existing;
  }

  const promise = ensureForgeCliUncached(cli, options).finally(() => {
    if (inFlightByCli.get(cli) === promise) {
      inFlightByCli.delete(cli);
    }
  });
  inFlightByCli.set(cli, promise);
  return promise;
}

interface VerifyChecksumParams {
  cli: ForgeCliId;
  filePath: string;
  assetFilename: string;
  lookupChecksum: (cli: ForgeCliId, assetFilename: string) => string | null;
  logger: pino.Logger;
}

// Returns false only on an actual mismatch (caller should treat that as a
// hard failure, same as a failed post-download probe). A missing catalog
// entry (mid version-bump, or an arch/platform combo we haven't published
// checksums for yet) isn't fatal on its own -- the post-download
// probeExecutable() check downstream is a lesser but non-zero safety net,
// so we log and let the download proceed rather than block auto-install
// entirely on the checksum data being complete.
async function verifyChecksum(params: VerifyChecksumParams): Promise<boolean> {
  const { cli, filePath, assetFilename, lookupChecksum, logger } = params;
  const expected = lookupChecksum(cli, assetFilename);
  if (!expected) {
    logger.warn(
      { assetFilename },
      "no pinned checksum for this forge CLI asset, skipping verification",
    );
    return true;
  }

  const actual = await sha256File(filePath);
  if (actual !== expected) {
    logger.error(
      { assetFilename, expected, actual },
      "forge CLI checksum mismatch, removing download",
    );
    return false;
  }
  return true;
}

async function ensureForgeCliUncached(
  cli: ForgeCliId,
  options: EnsureForgeCliOptions,
): Promise<string | null> {
  const logger = options.logger.child({ module: "forge-cli", component: "ensure-forge-cli", cli });
  const binaryPath = managedCliPath(options, cli);
  const fetchImpl = options.fetchImpl ?? fetch;
  const probe = options.probeExecutableImpl ?? probeExecutable;
  const lookupChecksum = options.getForgeCliChecksumImpl ?? getForgeCliChecksum;

  if (await probe(binaryPath)) {
    return binaryPath;
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const asset = resolveForgeCliAsset(cli, platform, arch);
  if (!asset) {
    // Only linux is in the catalog right now (this is a container-only
    // feature), so this fires on darwin/win32/unsupported arch. Not an
    // error, just nothing to do here.
    logger.warn({ platform, arch }, "no forge CLI asset for this platform/arch, skipping");
    return null;
  }

  logger.info({ url: asset.url }, "downloading forge CLI");

  try {
    const cliDir = path.dirname(binaryPath);
    await mkdir(cliDir, { recursive: true });
    const assetFilename = path.basename(new URL(asset.url).pathname);

    if (asset.archive === "none") {
      await downloadToFile(fetchImpl, asset.url, binaryPath);

      if (
        !(await verifyChecksum({
          cli,
          filePath: binaryPath,
          assetFilename,
          lookupChecksum,
          logger,
        }))
      ) {
        await rm(binaryPath, { force: true }).catch(() => undefined);
        return null;
      }
    } else {
      const downloadsDir = path.join(toolsDirFor(options), ".downloads", cli);
      const archivePath = path.join(downloadsDir, assetFilename);
      await downloadToFile(fetchImpl, asset.url, archivePath);

      // gh/glab publish checksums against the .tar.gz itself, not the
      // extracted binary, so verify before we ever touch tar.
      if (
        !(await verifyChecksum({
          cli,
          filePath: archivePath,
          assetFilename,
          lookupChecksum,
          logger,
        }))
      ) {
        await rm(archivePath, { force: true }).catch(() => undefined);
        return null;
      }

      const extractDir = path.join(downloadsDir, `${cli}-extract-${randomUUID()}`);
      await extractTarArchive(archivePath, extractDir);

      if (!asset.binaryPathInArchive) {
        throw new Error(`Catalog entry for ${cli} is missing binaryPathInArchive`);
      }
      await copyFile(path.join(extractDir, asset.binaryPathInArchive), binaryPath);

      await rm(archivePath, { force: true }).catch(() => undefined);
      await rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
    }

    await chmod(binaryPath, EXECUTABLE_MODE);

    if (!(await probe(binaryPath))) {
      logger.error({ binaryPath }, "downloaded forge CLI won't run, removing it");
      await rm(binaryPath, { force: true }).catch(() => undefined);
      return null;
    }

    logger.info({ binaryPath }, "forge CLI download done");
    return binaryPath;
  } catch (error) {
    logger.error({ err: error }, "forge CLI download failed");
    await rm(binaryPath, { force: true }).catch(() => undefined);
    return null;
  }
}
