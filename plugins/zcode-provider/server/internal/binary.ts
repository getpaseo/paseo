import { access, constants, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

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

/**
 * A resolved ZCode launch: the command, its arguments, and the environment the
 * child needs.
 */
export interface ZCodeLaunch {
  command: string;
  args: readonly string[];
  /** Extra environment for the child, beyond the inherited one. */
  env: Readonly<Record<string, string>>;
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

/**
 * The desktop app ships the CLI as a Node bundle under `resources/glm/`. The
 * bundle needs the built-in provider config, which the app passes through the
 * environment; the CLI only finds it next to its own entrypoint, and the
 * desktop app keeps it under `resources/config/`, not next to the bundle.
 * Without it the app-server exits before it answers anything.
 */
async function providerConfigEnv(
  bundlePath: string,
  configExists: (path: string) => Promise<boolean>,
): Promise<Record<string, string>> {
  const bundleDir = dirname(bundlePath);
  const candidates = [
    // The desktop app keeps the built-in provider config under
    // `resources/config/`, next to but outside the `glm/` runtime directory.
    join(bundleDir, "..", "config", "provider", "zcode-builtin.json"),
    // A standalone build may keep it next to the bundle.
    join(bundleDir, "provider", "zcode-builtin.json"),
  ];
  for (const candidate of candidates) {
    if (await configExists(candidate)) {
      return { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: candidate };
    }
  }
  return {};
}
interface DesktopBundle {
  /** Path of the runtime to spawn. */
  bundle: string;
  /** True when the runtime is a native executable rather than a Node bundle. */
  native: boolean;
}

async function findDesktopBundle(
  desktopRoots: readonly string[],
): Promise<DesktopBundle | undefined> {
  for (const root of desktopRoots) {
    // macOS: ZCode.app/Contents/Resources/glm. Windows and Linux: <app>/resources/glm.
    for (const glmDir of [
      join(root, "Contents", "Resources", "glm"),
      join(root, "resources", "glm"),
    ]) {
      const native = join(glmDir, "zcode-agent");
      if (await isExecutable(native)) return { bundle: native, native: true };
      const script = join(glmDir, "zcode.cjs");
      if (await isFile(script)) return { bundle: script, native: false };
    }
  }
  return undefined;
}

export async function resolveZCodeCommand(
  options: ZCodeDiscoveryOptions,
): Promise<readonly [string, ...string[]] | undefined> {
  const launch = await resolveZCodeLaunch(options);
  return launch ? ([launch.command, ...launch.args] as const) : undefined;
}

export async function resolveZCodeLaunch(
  options: ZCodeDiscoveryOptions,
): Promise<ZCodeLaunch | undefined> {
  const onPath = await findOnPath("zcode", options.pathEntries);
  if (onPath) {
    return { command: onPath, args: ["app-server", "--stdio"], env: {} };
  }

  const bundled = await findDesktopBundle(options.desktopRoots);
  if (bundled) {
    if (bundled.native) {
      return { command: bundled.bundle, args: ["app-server", "--stdio"], env: {} };
    }
    return {
      command: options.execPath ?? process.execPath,
      args: [bundled.bundle, "app-server", "--stdio"],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        ...(await providerConfigEnv(bundled.bundle, isFile)),
      },
    };
  }

  const fromEnv = options.env.GLM_BINARY_PATH?.trim();
  if (fromEnv && (await isExecutable(fromEnv))) {
    return { command: fromEnv, args: ["app-server", "--stdio"], env: {} };
  }

  return undefined;
}

export function defaultDesktopRoots(): readonly string[] {
  if (process.platform === "darwin") {
    return ["/Applications", join(process.env.HOME ?? "", "Applications")];
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const roots = localAppData ? [join(localAppData, "Programs")] : [];
    // The desktop app is also installable outside %LOCALAPPDATA%\Programs, so
    // the drives the user installs applications to are searched too.
    for (const drive of ["C:", "D:", "E:", "F:"]) {
      roots.push(join(`${drive}\\`, "Programs"));
    }
    return roots;
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
