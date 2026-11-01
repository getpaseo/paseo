import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface WindowsFindExecutableOptions {
  enumeratePathCandidates: (name: string) => Promise<string[]>;
  probeExecutable: (executablePath: string, timeoutMs: number) => Promise<boolean>;
  exists: (path: string) => boolean;
  localAppData?: string;
  probeTimeoutMs: number;
}

interface WindowsExecutableExistsOptions {
  exists: (path: string) => boolean;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function enumerateLiteralPathCandidates(executablePath: string): string[] {
  if (extname(executablePath)) {
    return [executablePath];
  }
  return [executablePath, `${executablePath}.exe`, `${executablePath}.cmd`];
}

function enumerateWingetPackageCandidates(
  name: string,
  localAppData: string | undefined,
): string[] {
  if (!localAppData) {
    return [];
  }

  const wingetPackages = join(localAppData, "Microsoft", "WinGet", "Packages");
  let packageDirs: string[];
  try {
    packageDirs = readdirSync(wingetPackages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const exeName = `${name}.exe`;
  return packageDirs.map((packageDir) => join(wingetPackages, packageDir, exeName));
}

async function find(input: string, options: WindowsFindExecutableOptions): Promise<string | null> {
  if (hasPathSeparator(input)) {
    return findFirstProbeable(enumerateLiteralPathCandidates(input), options);
  }

  const pathCandidates = await options.enumeratePathCandidates(input);
  const wingetCandidates = enumerateWingetPackageCandidates(
    input,
    options.localAppData ?? process.env.LOCALAPPDATA,
  ).filter(options.exists);

  return findFirstProbeable([...pathCandidates, ...wingetCandidates], options);
}

async function findFirstProbeable(
  candidates: string[],
  options: WindowsFindExecutableOptions,
): Promise<string | null> {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (!options.exists(candidate)) {
      continue;
    }
    if (await options.probeExecutable(candidate, options.probeTimeoutMs)) {
      return candidate;
    }
  }
  return null;
}

function exists(executablePath: string, options: WindowsExecutableExistsOptions): string | null {
  for (const candidate of enumerateLiteralPathCandidates(executablePath)) {
    if (options.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Windows hands a newly launched process the PATH that existed when its parent
// started. A long-running daemon therefore never sees CLIs installed afterwards:
// the installer updates the registry, not the daemon's inherited environment.
// Rebuild PATH from the registry so a restart (or the next daemon) can find them.
const WINDOWS_REGISTRY_PATH_KEYS = [
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  "HKCU\\Environment",
] as const;

const WINDOWS_REGISTRY_PATH_LINE = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i;

export type WindowsPathEnvironment = Record<string, string | undefined>;

export interface WindowsPathEnvironmentOptions {
  env?: WindowsPathEnvironment;
  exec?: (file: string, args: string[]) => Promise<string>;
  platform?: NodeJS.Platform;
}

export function parseWindowsRegistryPath(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(WINDOWS_REGISTRY_PATH_LINE);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return null;
}

export function expandWindowsEnvironmentVariables(
  value: string,
  env: WindowsPathEnvironment = process.env,
): string {
  const lookup = new Map<string, string>();
  for (const [key, entry] of Object.entries(env)) {
    if (entry !== undefined) {
      lookup.set(key.toLowerCase(), entry);
    }
  }

  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    return lookup.get(name.toLowerCase()) ?? match;
  });
}

function splitWindowsPath(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(";")
    .map((entry) =>
      entry
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim(),
    )
    .filter(Boolean);
}

function windowsPathEntryKey(entry: string): string {
  return entry.replace(/[\\/]+$/, "").toLowerCase();
}

export function mergeWindowsPathValues(...values: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const value of values) {
    for (const entry of splitWindowsPath(value ?? undefined)) {
      const key = windowsPathEntryKey(entry);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries.join(";");
}

export async function readWindowsEnvironmentPath(
  options: WindowsPathEnvironmentOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return null;
  }

  const env = options.env ?? process.env;
  const run =
    options.exec ??
    (async (file: string, args: string[]) => {
      const { stdout } = await execFileAsync(file, args, {
        encoding: "utf8",
        env: env as NodeJS.ProcessEnv,
        timeout: 2_000,
        windowsHide: true,
      });
      return stdout;
    });
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "C:\\Windows";
  const regExe = join(systemRoot, "System32", "reg.exe");

  const registryValues = (
    await Promise.all(
      WINDOWS_REGISTRY_PATH_KEYS.map(async (key) => {
        try {
          const value = parseWindowsRegistryPath(await run(regExe, ["query", key, "/v", "Path"]));
          return value ? [expandWindowsEnvironmentVariables(value, env)] : [];
        } catch {
          // A missing Path value exits non-zero; that registry hive simply contributes none.
          return [];
        }
      }),
    )
  ).flat();

  return registryValues.length > 0 ? mergeWindowsPathValues(...registryValues) : null;
}

/**
 * Append PATH entries from the current user/machine registry environment to a
 * process environment. Existing entries keep their order and take precedence.
 */
export async function refreshWindowsProcessPath(
  options: WindowsPathEnvironmentOptions = {},
): Promise<{ added: string[] }> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { added: [] };
  }

  const env = options.env ?? process.env;
  const registryPath = await readWindowsEnvironmentPath({ ...options, env, platform });
  if (!registryPath) {
    return { added: [] };
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  const current = env[pathKey];
  const merged = mergeWindowsPathValues(current, registryPath);
  if (merged === current) {
    return { added: [] };
  }

  const currentEntries = new Set(splitWindowsPath(current).map(windowsPathEntryKey));
  const added = splitWindowsPath(registryPath).filter(
    (entry) => !currentEntries.has(windowsPathEntryKey(entry)),
  );
  env[pathKey] = merged;
  return { added };
}

export const windowsExecutableResolution = {
  exists,
  find,
};
