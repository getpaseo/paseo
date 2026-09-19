import { createRequire } from "node:module";
import path from "node:path";

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

export function prependEnvPath(existing: string | undefined, value: string): string {
  const parts = (existing ?? "").split(path.delimiter).filter(Boolean);
  if (parts.includes(value)) {
    return parts.join(path.delimiter);
  }
  return [value, ...parts].join(path.delimiter);
}

/**
 * Inside packaged Electron, module resolution returns paths inside the
 * `app.asar` archive file. The native libraries live in `app.asar.unpacked`,
 * and a loader path inside a file is unusable for the OS loader and for child
 * processes — on Windows, Git Bash truncates the PATH it hands to native
 * executables at such an entry.
 */
function toUnpackedAsarPath(dir: string): string {
  return dir.replace(/([\\/])app\.asar(?=[\\/]|$)/, "$1app.asar.unpacked");
}

export function resolveSherpaLoaderEnv(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  resolvePackageJson: (id: string) => string = createRequire(import.meta.url).resolve,
): SherpaLoaderEnvResolution | null {
  const key = sherpaLoaderEnvKey(platform);
  if (!key) {
    return null;
  }

  const packageName = sherpaPlatformPackageName(platform, arch);
  try {
    const pkgJson = resolvePackageJson(`${packageName}/package.json`);
    return {
      key,
      libDir: toUnpackedAsarPath(path.dirname(pkgJson)),
      packageName,
    };
  } catch {
    return null;
  }
}

/**
 * Find the actual case-sensitive key in a plain object that matches the given
 * key case-insensitively. On Windows, `{...process.env}` produces a plain
 * (case-sensitive) object where PATH is typically stored as `Path`. Using a
 * hardcoded `"PATH"` would miss the existing key and create a duplicate,
 * breaking the child process's PATH.
 */
function findEnvKey(env: NodeJS.ProcessEnv, key: string): string {
  const lower = key.toLowerCase();
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === lower) return k;
  }
  return key;
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
