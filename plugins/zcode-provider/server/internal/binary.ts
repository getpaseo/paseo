import { access, constants, readdir } from "node:fs/promises";
import { join } from "node:path";

export const ZCODE_NOT_FOUND_DIAGNOSTIC = [
  "ZCode was not found.",
  "Install the ZCode CLI (@zcode/cli) so `zcode` is on PATH, or set",
  "agents.providers.zcode.command, or install the ZCode desktop app so its",
  "bundled runtime is discovered, or set GLM_BINARY_PATH.",
].join(" ");

export interface ZCodeDiscoveryOptions {
  /** PATH entries to search for a `zcode` executable. */
  pathEntries: readonly string[];
  /** Environment to consult, including GLM_BINARY_PATH. */
  env: Readonly<Record<string, string | undefined>>;
  /** Roots that may contain a ZCode desktop app bundle. */
  desktopRoots: readonly string[];
  /** Runtime used to execute a bundled JavaScript entry. Defaults to this process. */
  execPath?: string;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(
  name: string,
  pathEntries: readonly string[],
): Promise<string | undefined> {
  for (const entry of pathEntries) {
    const candidate = join(entry, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function findDesktopBundle(
  desktopRoots: readonly string[],
): Promise<{ bundle: string; native: boolean } | undefined> {
  for (const root of desktopRoots) {
    const glmDir = join(root, "Contents", "Resources", "glm");
    const native = join(glmDir, "zcode-agent");
    if (await isExecutable(native)) return { bundle: native, native: true };
    const script = join(glmDir, "zcode.cjs");
    if (await isFile(script)) return { bundle: script, native: false };
  }
  return undefined;
}

export async function resolveZCodeCommand(
  options: ZCodeDiscoveryOptions,
): Promise<readonly [string, ...string[]] | undefined> {
  const onPath = await findOnPath("zcode", options.pathEntries);
  if (onPath) return [onPath, "app-server", "--stdio"];

  const bundled = await findDesktopBundle(options.desktopRoots);
  if (bundled) {
    if (bundled.native) return [bundled.bundle, "app-server", "--stdio"];
    return [options.execPath ?? process.execPath, bundled.bundle, "app-server", "--stdio"];
  }

  const fromEnv = options.env.GLM_BINARY_PATH?.trim();
  if (fromEnv && (await isExecutable(fromEnv))) return [fromEnv, "app-server", "--stdio"];

  return undefined;
}

export function defaultDesktopRoots(): readonly string[] {
  if (process.platform === "darwin") {
    return ["/Applications", join(process.env.HOME ?? "", "Applications")];
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    return localAppData ? [join(localAppData, "Programs")] : [];
  }
  return ["/opt", "/usr/share"];
}

export async function listDesktopAppRoots(roots: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.toLowerCase().startsWith("zcode")) found.push(join(root, entry));
    }
  }
  return found;
}
