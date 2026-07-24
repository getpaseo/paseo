import path from "node:path";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import { z } from "zod";
import { execCommand } from "../../../utils/spawn.js";

export const PASEO_CLI_PACKAGE = "@getpaseo/cli";

const PROBE_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 300_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export type PackageManagerName = "npm" | "pnpm";

export interface CommandOptions {
  timeout?: number;
  maxBuffer?: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export interface GlobalPaseoInstall {
  packageManager: PackageManagerName;
  version: string;
  packagePath: string;
  isLinked: boolean;
  /**
   * Directories the running daemon's `@getpaseo/server` package must resolve
   * under for this install to "own" the daemon. Compared with realpath-aware
   * containment, so symlinked stores (pnpm) and nested/hoisted layouts (npm)
   * both work.
   */
  containmentRoots: string[];
}

export interface GlobalCliPackageManager {
  readonly name: PackageManagerName;
  /**
   * Returns `null` when `@getpaseo/cli` is not installed globally via this
   * package manager, or the package manager is not available on the host. Only
   * genuinely unexpected failures reject.
   */
  inspect(): Promise<GlobalPaseoInstall | null>;
  installLatest(): Promise<CommandResult>;
}

const CommandErrorSchema = z
  .object({
    code: z.union([z.number(), z.string()]).optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  })
  .passthrough();

async function runExternalCommand(
  command: string,
  args: string[],
  options?: CommandOptions,
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execCommand(command, args, {
      timeout: options?.timeout,
      maxBuffer: options?.maxBuffer,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const parsed = CommandErrorSchema.safeParse(error);
    if (!parsed.success) {
      return { exitCode: 1, stdout: "", stderr: getErrorMessage(error) };
    }

    return {
      exitCode: typeof parsed.data.code === "number" ? parsed.data.code : 1,
      stdout: parsed.data.stdout ?? "",
      stderr: parsed.data.stderr || getErrorMessage(error),
    };
  }
}

const NpmGlobalListSchema = z
  .object({
    path: z.string().optional(),
    dependencies: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const NpmGlobalCliPackageSchema = z
  .object({
    version: z.string(),
    path: z.string(),
    link: z.boolean().optional(),
  })
  .passthrough();

function npmGlobalNodeModules(globalRootPath: string): string {
  const normalized = path.normalize(globalRootPath);
  return path.basename(normalized) === "node_modules"
    ? normalized
    : path.join(normalized, "node_modules");
}

function parseNpmGlobalPaseoInstall(stdout: string): GlobalPaseoInstall | null {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stdout);
  } catch {
    return null;
  }

  const list = NpmGlobalListSchema.safeParse(parsedJson);
  if (!list.success) {
    return null;
  }

  const cliPackage = NpmGlobalCliPackageSchema.safeParse(
    list.data.dependencies?.[PASEO_CLI_PACKAGE],
  );
  if (!cliPackage.success) {
    return null;
  }

  // npm keeps the cli package and its dependencies inside the global
  // node_modules tree: `@getpaseo/server` is either nested under the cli
  // package or hoisted next to it. Either way it lives under one of these roots.
  const containmentRoots = list.data.path
    ? [cliPackage.data.path, npmGlobalNodeModules(list.data.path)]
    : [cliPackage.data.path];

  return {
    packageManager: "npm",
    version: cliPackage.data.version,
    packagePath: cliPackage.data.path,
    isLinked: cliPackage.data.link === true,
    containmentRoots,
  };
}

export class DefaultNpmGlobalCli implements GlobalCliPackageManager {
  readonly name = "npm" as const;

  constructor(private readonly runCommand: CommandRunner = runExternalCommand) {}

  async inspect(): Promise<GlobalPaseoInstall | null> {
    const result = await this.runCommand(
      "npm",
      ["-g", "ls", PASEO_CLI_PACKAGE, "--json", "--depth=0", "--long"],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
    );

    return parseNpmGlobalPaseoInstall(result.stdout);
  }

  installLatest(): Promise<CommandResult> {
    return this.runCommand("npm", ["install", "-g", `${PASEO_CLI_PACKAGE}@latest`], {
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    });
  }
}

const PnpmGlobalCliPackageSchema = z
  .object({
    version: z.string(),
    path: z.string().optional(),
  })
  .passthrough();

const PnpmGlobalListEntrySchema = z
  .object({
    path: z.string().optional(),
    dependencies: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

function parsePnpmGlobalPaseoInstall(stdout: string): GlobalPaseoInstall | null {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stdout);
  } catch {
    return null;
  }

  // `pnpm ls -g --json` prints an array of project entries; the global project
  // is the first (and only) element. Older shapes may return the object bare.
  const rawEntry = Array.isArray(parsedJson) ? parsedJson[0] : parsedJson;
  const entry = PnpmGlobalListEntrySchema.safeParse(rawEntry);
  if (!entry.success) {
    return null;
  }

  const cliPackage = PnpmGlobalCliPackageSchema.safeParse(
    entry.data.dependencies?.[PASEO_CLI_PACKAGE],
  );
  if (!cliPackage.success) {
    return null;
  }

  const globalRoot = entry.data.path ?? null;
  const containmentRoots: string[] = [];
  if (globalRoot) {
    // pnpm resolves globally-installed packages through a content-addressable
    // store that is a sibling of the global dir (e.g. `~/.pnpm/store` next to
    // `~/.pnpm/global/v11`), so the running daemon's real path lives under the
    // pnpm home rather than the global dir itself. The home contains both.
    containmentRoots.push(globalRoot, path.dirname(path.dirname(globalRoot)));
  }

  return {
    packageManager: "pnpm",
    version: cliPackage.data.version,
    packagePath: cliPackage.data.path ?? "",
    // A `pnpm link --global` checkout resolves `@getpaseo/server` to the dev
    // source, which is outside the pnpm home, so containment already refuses to
    // self-update it; no separate linked probe is needed.
    isLinked: false,
    containmentRoots,
  };
}

export class DefaultPnpmGlobalCli implements GlobalCliPackageManager {
  readonly name = "pnpm" as const;

  constructor(private readonly runCommand: CommandRunner = runExternalCommand) {}

  async inspect(): Promise<GlobalPaseoInstall | null> {
    const result = await this.runCommand("pnpm", ["ls", "-g", "--json", "--depth=0"], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    });

    return parsePnpmGlobalPaseoInstall(result.stdout);
  }

  installLatest(): Promise<CommandResult> {
    return this.runCommand("pnpm", ["add", "-g", `${PASEO_CLI_PACKAGE}@latest`], {
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    });
  }
}

export const globalCliPackageManagers: readonly GlobalCliPackageManager[] = [
  new DefaultNpmGlobalCli(),
  new DefaultPnpmGlobalCli(),
];
