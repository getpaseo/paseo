import path from "node:path";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import { z } from "zod";
import type { ProcessEnvRecord } from "../../paseo-env.js";
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
  /** Spawn-level failure code (e.g. "ENOENT") when the command could not run at all. */
  errorCode?: string;
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
   * Returns `null` when this package manager is not on the host or
   * `@getpaseo/cli` is not installed globally with it. Rejects when the probe
   * itself fails (timeout, permissions, unparseable output), so callers can
   * surface the failure instead of mistaking it for a missing install.
   */
  inspect(): Promise<GlobalPaseoInstall | null>;
  installLatest(): Promise<CommandResult>;
}

const CommandErrorSchema = z
  .object({
    code: z.union([z.number(), z.string()]).nullish(),
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
      errorCode: typeof parsed.data.code === "string" ? parsed.data.code : undefined,
    };
  }
}

// ENOENT is what a shell-less spawn reports for a missing binary; 127 is the
// POSIX shell "command not found" status and 9009 is cmd.exe's. Anything else
// is a real probe failure and must not be mistaken for "not installed".
function isCommandNotFound(result: CommandResult): boolean {
  return result.errorCode === "ENOENT" || result.exitCode === 127 || result.exitCode === 9009;
}

function probeFailure(commandLabel: string, result: CommandResult): Error {
  const detail = result.stderr.trim() || `exited with code ${result.exitCode}`;
  return new Error(`${commandLabel} failed: ${detail}`);
}

type ProbeParseResult =
  | { status: "install"; install: GlobalPaseoInstall }
  | { status: "not-installed" }
  | { status: "unparseable" };

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

function parseNpmGlobalPaseoInstall(stdout: string): ProbeParseResult {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stdout);
  } catch {
    return { status: "unparseable" };
  }

  const list = NpmGlobalListSchema.safeParse(parsedJson);
  if (!list.success) {
    return { status: "not-installed" };
  }

  const cliPackage = NpmGlobalCliPackageSchema.safeParse(
    list.data.dependencies?.[PASEO_CLI_PACKAGE],
  );
  if (!cliPackage.success) {
    return { status: "not-installed" };
  }

  // npm keeps the cli package and its dependencies inside the global
  // node_modules tree: `@getpaseo/server` is either nested under the cli
  // package or hoisted next to it. Either way it lives under one of these roots.
  const containmentRoots = list.data.path
    ? [cliPackage.data.path, npmGlobalNodeModules(list.data.path)]
    : [cliPackage.data.path];

  return {
    status: "install",
    install: {
      packageManager: "npm",
      version: cliPackage.data.version,
      packagePath: cliPackage.data.path,
      isLinked: cliPackage.data.link === true,
      containmentRoots,
    },
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
    if (isCommandNotFound(result)) {
      return null;
    }

    // npm prints JSON on stdout even when the package is missing, so
    // unparseable output means the probe itself broke, not a missing install.
    const parsed = parseNpmGlobalPaseoInstall(result.stdout);
    if (parsed.status === "unparseable") {
      throw probeFailure("npm -g ls", result);
    }
    return parsed.status === "install" ? parsed.install : null;
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

function pnpmContainmentRoots(globalRoot: string, env: ProcessEnvRecord): string[] {
  // pnpm resolves globally-installed packages through a content-addressable
  // store under the pnpm home (e.g. `~/.pnpm/store/v11/links/...` next to
  // `~/.pnpm/global/v11`), so the running daemon's real path lives under the
  // home rather than the global dir itself.
  const roots = [globalRoot];
  const envHome = env.PNPM_HOME?.trim();
  if (envHome) {
    roots.push(envHome);
  }

  // The daemon may not inherit the user's shell env, so also derive the home
  // from the standard `<home>/global/<version>` layout. Skip the derivation
  // when a custom `global-dir` breaks that layout: a grandparent of an
  // arbitrary directory could widen containment to an unrelated ancestor.
  const parent = path.dirname(globalRoot);
  const derivedHome = path.dirname(parent);
  if (path.basename(parent) === "global" && !roots.includes(derivedHome)) {
    roots.push(derivedHome);
  }
  return roots;
}

function parsePnpmGlobalPaseoInstall(stdout: string, env: ProcessEnvRecord): ProbeParseResult {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stdout);
  } catch {
    return { status: "unparseable" };
  }

  // `pnpm ls -g --json` prints an array of project entries; the global project
  // is the first (and only) element. Older shapes may return the object bare.
  const rawEntry = Array.isArray(parsedJson) ? parsedJson[0] : parsedJson;
  const entry = PnpmGlobalListEntrySchema.safeParse(rawEntry);
  if (!entry.success) {
    return { status: "not-installed" };
  }

  const cliPackage = PnpmGlobalCliPackageSchema.safeParse(
    entry.data.dependencies?.[PASEO_CLI_PACKAGE],
  );
  if (!cliPackage.success) {
    return { status: "not-installed" };
  }

  return {
    status: "install",
    install: {
      packageManager: "pnpm",
      version: cliPackage.data.version,
      packagePath: cliPackage.data.path ?? "",
      // A `pnpm link --global` checkout resolves `@getpaseo/server` to the dev
      // source, which is outside the pnpm home, so containment already refuses
      // to self-update it; no separate linked probe is needed.
      //
      // Accepted residual looseness: with `enable-global-virtual-store` (off by
      // default) a project-local install resolves to the same store files as
      // the global one, so a local daemon at the exact global version would be
      // claimed too — the files are byte-identical and provenance is not
      // observable in-process. The version equality check in install-origin is
      // the guard for that window.
      isLinked: false,
      containmentRoots: entry.data.path ? pnpmContainmentRoots(entry.data.path, env) : [],
    },
  };
}

export class DefaultPnpmGlobalCli implements GlobalCliPackageManager {
  readonly name = "pnpm" as const;

  constructor(
    private readonly runCommand: CommandRunner = runExternalCommand,
    private readonly env: ProcessEnvRecord = process.env,
  ) {}

  async inspect(): Promise<GlobalPaseoInstall | null> {
    const result = await this.runCommand("pnpm", ["ls", "-g", "--json", "--depth=0"], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    if (isCommandNotFound(result)) {
      return null;
    }

    const parsed = parsePnpmGlobalPaseoInstall(result.stdout, this.env);
    if (parsed.status === "unparseable") {
      throw probeFailure("pnpm ls -g", result);
    }
    return parsed.status === "install" ? parsed.install : null;
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
