import { statSync } from "node:fs";

import { hasRequiredFiles } from "../sherpa/model-downloader.js";
import type { LocalSpeechRuntimeStatus } from "./errors.js";
import { getLocalSpeechRuntimePackageSpecs } from "./package-specs.js";
import {
  getLocalSpeechRuntimeDir,
  getLocalSpeechRuntimePackageDirFromRuntimeDir,
} from "./paths.js";

function hasRequiredFileSync(filePath: string): boolean {
  try {
    const s = statSync(filePath);
    if (s.isDirectory()) {
      return true;
    }
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

function hasRequiredFilesSync(packageDir: string, requiredFiles: string[]): boolean {
  return requiredFiles.every((relPath) => hasRequiredFileSync(`${packageDir}/${relPath}`));
}

export function getLocalSpeechRuntimeStatusSync(params: {
  paseoHome: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): LocalSpeechRuntimeStatus {
  const runtimeDir = getLocalSpeechRuntimeDir(params.paseoHome);
  const missingPackageIds: LocalSpeechRuntimeStatus["missingPackageIds"] = [];
  for (const spec of getLocalSpeechRuntimePackageSpecs(params.platform, params.arch)) {
    const packageDir = getLocalSpeechRuntimePackageDirFromRuntimeDir(runtimeDir, spec.packageName);
    const requiredFilesPresent = hasRequiredFilesSync(packageDir, spec.requiredFiles);
    if (!requiredFilesPresent || (spec.validate && !spec.validate(packageDir))) {
      missingPackageIds.push(spec.id);
    }
  }
  return {
    runtimeDir,
    missingPackageIds,
  };
}

export async function getLocalSpeechRuntimeStatus(params: {
  paseoHome: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<LocalSpeechRuntimeStatus> {
  const runtimeDir = getLocalSpeechRuntimeDir(params.paseoHome);
  const missingPackageIds: LocalSpeechRuntimeStatus["missingPackageIds"] = [];
  for (const spec of getLocalSpeechRuntimePackageSpecs(params.platform, params.arch)) {
    const packageDir = getLocalSpeechRuntimePackageDirFromRuntimeDir(runtimeDir, spec.packageName);
    const requiredFilesPresent = await hasRequiredFiles(packageDir, spec.requiredFiles);
    if (!requiredFilesPresent || (spec.validate && !spec.validate(packageDir))) {
      missingPackageIds.push(spec.id);
    }
  }
  return {
    runtimeDir,
    missingPackageIds,
  };
}
