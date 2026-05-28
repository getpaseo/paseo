import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type pino from "pino";

import {
  downloadToFile,
  extractTarArchive,
  hasRequiredFiles,
  isNonEmptyFile,
} from "../sherpa/model-downloader.js";
import { LocalSpeechRuntimeUnavailableError, type LocalSpeechRuntimeStatus } from "./errors.js";
import {
  getLocalSpeechRuntimePackageSpecs,
  type LocalSpeechRuntimePackageSpec,
} from "./package-specs.js";
import {
  getLocalSpeechRuntimeDir,
  getLocalSpeechRuntimePackageDirFromRuntimeDir,
} from "./paths.js";
import { getLocalSpeechRuntimeStatus } from "./status.js";

function npmTarballUrl(packageName: string, version: string): string {
  const escapedName = packageName.startsWith("@") ? packageName.replace("/", "%2f") : packageName;
  const basename = packageName.startsWith("@") ? packageName.split("/")[1] : packageName;
  return `https://registry.npmjs.org/${escapedName}/-/${basename}-${version}.tgz`;
}

async function installPackageFromTarball(params: {
  runtimeDir: string;
  spec: LocalSpeechRuntimePackageSpec;
}): Promise<void> {
  const { runtimeDir, spec } = params;
  const packageDir = getLocalSpeechRuntimePackageDirFromRuntimeDir(runtimeDir, spec.packageName);
  if (
    (await hasRequiredFiles(packageDir, spec.requiredFiles)) &&
    (!spec.validate || spec.validate(packageDir))
  ) {
    return;
  }

  const downloadsDir = path.join(runtimeDir, ".downloads");
  const archivePath = path.join(
    downloadsDir,
    `${spec.packageName.replace("/", "__")}-${spec.version}.tgz`,
  );
  if (!(await isNonEmptyFile(archivePath))) {
    await downloadToFile({
      url: npmTarballUrl(spec.packageName, spec.version),
      outputPath: archivePath,
    });
  }

  const extractDir = path.join(
    runtimeDir,
    ".extract",
    `${spec.packageName.replace("/", "__")}-${Date.now()}`,
  );
  const extractedPackageDir = path.join(extractDir, "package");
  const nextPackageDir = `${packageDir}.tmp-${Date.now()}`;

  await rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(path.dirname(packageDir), { recursive: true });
  await extractTarArchive(archivePath, extractDir);
  await rm(nextPackageDir, { recursive: true, force: true }).catch(() => undefined);
  await rename(extractedPackageDir, nextPackageDir);

  if (
    !(await hasRequiredFiles(nextPackageDir, spec.requiredFiles)) ||
    (spec.validate && !spec.validate(nextPackageDir))
  ) {
    await rm(nextPackageDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(
      `Downloaded ${spec.packageName}@${spec.version}, but required runtime files are missing.`,
    );
  }

  await rm(packageDir, { recursive: true, force: true }).catch(() => undefined);
  await rename(nextPackageDir, packageDir);
  await rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(archivePath, { force: true }).catch(() => undefined);
}

export async function ensureLocalSpeechRuntime(options: {
  paseoHome: string;
  logger: pino.Logger;
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<LocalSpeechRuntimeStatus> {
  const logger = options.logger.child({
    module: "speech",
    provider: "local",
    component: "runtime-installer",
  });
  const runtimeDir = getLocalSpeechRuntimeDir(options.paseoHome);
  const specs = getLocalSpeechRuntimePackageSpecs(options.platform, options.arch);
  const before = await getLocalSpeechRuntimeStatus({
    paseoHome: options.paseoHome,
    platform: options.platform,
    arch: options.arch,
  });
  if (before.missingPackageIds.length === 0) {
    return before;
  }

  logger.info(
    {
      runtimeDir,
      missingPackageIds: before.missingPackageIds,
    },
    "Starting local speech runtime install",
  );

  for (const spec of specs) {
    await installPackageFromTarball({ runtimeDir, spec });
  }

  const after = await getLocalSpeechRuntimeStatus({
    paseoHome: options.paseoHome,
    platform: options.platform,
    arch: options.arch,
  });
  if (after.missingPackageIds.length > 0) {
    throw new LocalSpeechRuntimeUnavailableError(after);
  }

  logger.info({ runtimeDir }, "Local speech runtime install completed");
  return after;
}
