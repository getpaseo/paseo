import path from "node:path";

const PASEO_NODE_ENV = "PASEO_NODE_ENV";
const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

const RUNTIME_CONTROL_ENV_KEYS = [
  PASEO_NODE_ENV,
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SUPERVISED",
  ELECTRON_RUN_AS_NODE,
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ESBUILD_BINARY_PATH",
] as const;

const APPIMAGE_RUNTIME_ENV_KEYS = [
  "APPIMAGE",
  "APPDIR",
  "ARGV0",
  "OWD",
  "APPIMAGE_LIBRARY_PATH",
] as const;

const APPIMAGE_PATH_LIST_VARS = [
  { key: "PATH", splitRegex: /:/ },
  { key: "LD_LIBRARY_PATH", splitRegex: /[:;]/ },
  { key: "XDG_DATA_DIRS", splitRegex: /:/ },
  { key: "GSETTINGS_SCHEMA_DIR", splitRegex: /:/ },
] as const;

export type PaseoNodeEnv = "development" | "production" | "test";
export type ProcessEnvRecord = Record<string, string | undefined>;
export type ExternalProcessEnv = NodeJS.ProcessEnv & Record<string, string>;

function normalizeAppDir(rawAppDir: string | undefined): string | null {
  if (!rawAppDir) return null;
  const normalized = path.posix.normalize(rawAppDir).replace(/\/+$/, "");
  return normalized.startsWith("/") ? normalized : null;
}

function isAppDirPathSegment(segment: string, appDir: string): boolean {
  if (!segment.startsWith("/")) return false;
  const normalized = path.posix.normalize(segment).replace(/\/+$/, "");
  return normalized === appDir || normalized.startsWith(`${appDir}/`);
}

function stripAppDirSegments(
  value: string,
  appDir: string,
  splitRegex: RegExp,
): string | undefined {
  const segments = value.split(splitRegex);
  const filtered = segments.filter((segment) => !isAppDirPathSegment(segment, appDir));
  if (filtered.length === segments.length) {
    return value.length === 0 ? undefined : value;
  }
  const joined = filtered.join(":");
  return joined.length === 0 ? undefined : joined;
}

/**
 * Remove Linux AppImage runtime variables and `$APPDIR` path-list entries from a
 * child environment object without touching Electron main's own `process.env`.
 */
export function stripAppImageRuntimeEnv(
  env: ProcessEnvRecord,
  options?: { platform?: NodeJS.Platform },
): void {
  const platform = options?.platform ?? process.platform;
  if (platform !== "linux") return;
  if (!env.APPIMAGE && !env.APPDIR) return;

  const appDir = normalizeAppDir(env.APPDIR);

  for (const key of APPIMAGE_RUNTIME_ENV_KEYS) {
    delete env[key];
  }

  if (!appDir) return;

  for (const { key, splitRegex } of APPIMAGE_PATH_LIST_VARS) {
    const value = env[key];
    if (typeof value !== "string") continue;
    const scrubbed = stripAppDirSegments(value, appDir, splitRegex);
    if (scrubbed === undefined) {
      delete env[key];
    } else {
      env[key] = scrubbed;
    }
  }
}

function buildInternalProcessEnv<T extends ProcessEnvRecord>(baseEnv: T): T {
  return { ...baseEnv };
}

function buildExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  overlays: ProcessEnvRecord[],
): ExternalProcessEnv {
  const sanitized = Object.assign({}, baseEnv, ...overlays);
  for (const key of RUNTIME_CONTROL_ENV_KEYS) {
    delete sanitized[key];
  }
  stripAppImageRuntimeEnv(sanitized);
  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined) {
      delete sanitized[key];
    }
  }
  return sanitized as ExternalProcessEnv;
}

export function createPaseoInternalEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildInternalProcessEnv(baseEnv);
}

export function createExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function createExternalCommandProcessEnv(
  _command: string,
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  // Deprecated command parameter: retained while callers migrate to createExternalProcessEnv.
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function buildSelfNodeCommand(
  args: string[],
  envOverlay?: ProcessEnvRecord,
): {
  command: string;
  args: string[];
  env: ExternalProcessEnv;
} {
  const env = buildExternalProcessEnv(process.env, []);
  Object.assign(env, { [ELECTRON_RUN_AS_NODE]: "1" }, envOverlay);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  return {
    command: process.execPath,
    args,
    env,
  };
}

export function resolvePaseoNodeEnv(env: NodeJS.ProcessEnv): PaseoNodeEnv | undefined {
  const value = env[PASEO_NODE_ENV];
  return value === "development" || value === "production" || value === "test" ? value : undefined;
}
