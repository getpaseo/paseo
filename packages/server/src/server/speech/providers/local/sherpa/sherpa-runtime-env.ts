import { createRequire } from "node:module";
import path from "node:path";
import { findEnvKey, prependEnvPath } from "../../../../../utils/env-path.js";

export type SherpaLoaderEnvKey = "LD_LIBRARY_PATH" | "DYLD_LIBRARY_PATH" | "PATH";

export interface SherpaLoaderEnvResolution {
  key: SherpaLoaderEnvKey;
  libDir: string;
  packageName: string;
}

export function sherpaPlatformArch(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const normalizedPlatform = platform === "win32" ? "win" : platform;
  return `${normalizedPlatform}-${arch}`;
}

export function sherpaPlatformPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `sherpa-onnx-${sherpaPlatformArch(platform, arch)}`;
}

export function sherpaLoaderEnvKey(
  platform: NodeJS.Platform = process.platform,
): SherpaLoaderEnvKey | null {
  if (platform === "linux") {
    return "LD_LIBRARY_PATH";
  }
  if (platform === "darwin") {
    return "DYLD_LIBRARY_PATH";
  }
  if (platform === "win32") {
    return "PATH";
  }
  return null;
}

export function resolveSherpaLoaderEnv(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): SherpaLoaderEnvResolution | null {
  const key = sherpaLoaderEnvKey(platform);
  if (!key) {
    return null;
  }

  const packageName = sherpaPlatformPackageName(platform, arch);
  const require = createRequire(import.meta.url);
  try {
    const pkgJson = require.resolve(`${packageName}/package.json`);
    return {
      key,
      libDir: path.dirname(pkgJson),
      packageName,
    };
  } catch {
    return null;
  }
}

export function applySherpaLoaderEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): {
  changed: boolean;
  key: SherpaLoaderEnvKey | null;
  libDir: string | null;
  packageName: string | null;
} {
  const resolved = resolveSherpaLoaderEnv(platform, arch);
  if (!resolved) {
    return {
      changed: false,
      key: null,
      libDir: null,
      packageName: null,
    };
  }

  const actualKey = findEnvKey(env, resolved.key);
  const next = prependEnvPath(env[actualKey], resolved.libDir);
  const changed = next !== (env[actualKey] ?? "");
  env[actualKey] = next;
  return {
    changed,
    key: resolved.key,
    libDir: resolved.libDir,
    packageName: resolved.packageName,
  };
}
