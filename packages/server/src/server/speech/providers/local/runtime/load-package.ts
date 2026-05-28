import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { LocalSpeechRuntimeUnavailableError } from "./errors.js";
import { getLocalSpeechRuntimePackageDir } from "./paths.js";
import { getLocalSpeechRuntimeStatusSync } from "./status.js";
import {
  prependEnvPath,
  sherpaLoaderEnvKey,
  sherpaPlatformPackageName,
} from "../sherpa/sherpa-runtime-env.js";

let configuredPaseoHome: string | null = null;

export function configureLocalSpeechRuntimeHome(paseoHome: string): void {
  configuredPaseoHome = paseoHome;
}

export function clearLocalSpeechRuntimeHome(): void {
  configuredPaseoHome = null;
}

function findEnvKey(env: NodeJS.ProcessEnv, key: string): string {
  const lower = key.toLowerCase();
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === lower) return k;
  }
  return key;
}

function applyConfiguredSherpaLoaderEnv(): void {
  if (!configuredPaseoHome) {
    return;
  }
  const envKey = sherpaLoaderEnvKey();
  if (!envKey) {
    return;
  }
  const platformPackageDir = getLocalSpeechRuntimePackageDir(
    configuredPaseoHome,
    sherpaPlatformPackageName(),
  );
  const actualKey = findEnvKey(process.env, envKey);
  process.env[actualKey] = prependEnvPath(process.env[actualKey], platformPackageDir);
}

export function loadLocalSpeechPackage<T>(
  packageName: string,
  options?: { requireFrom?: string },
): T {
  const devRequire = createRequire(options?.requireFrom ?? import.meta.url);
  if (!configuredPaseoHome) {
    return devRequire(packageName) as T;
  }

  if (packageName === "sherpa-onnx-node") {
    applyConfiguredSherpaLoaderEnv();
  }

  const status = getLocalSpeechRuntimeStatusSync({ paseoHome: configuredPaseoHome });
  if (status.missingPackageIds.length > 0) {
    throw new LocalSpeechRuntimeUnavailableError(status);
  }

  const runtimePackageDir = getLocalSpeechRuntimePackageDir(configuredPaseoHome, packageName);
  const runtimePackageJson = path.join(runtimePackageDir, "package.json");
  if (existsSync(runtimePackageJson)) {
    const runtimeRequire = createRequire(runtimePackageJson);
    return runtimeRequire(runtimePackageDir) as T;
  }

  throw new LocalSpeechRuntimeUnavailableError(status);
}
