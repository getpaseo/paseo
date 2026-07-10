import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import { z } from "zod";
import { execCommand } from "../../../utils/spawn.js";

export const PASEO_CLI_PACKAGE = "@getpaseo/cli";

const NPM_PROBE_TIMEOUT_MS = 10_000;
const NPM_INSTALL_TIMEOUT_MS = 300_000;
const NPM_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

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

const CommandErrorSchema = z
  .object({
    code: z.union([z.number(), z.string()]).optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  })
  .passthrough();

export interface CommandOptions {
  timeout?: number;
  maxBuffer?: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface NpmGlobalPaseoInstall {
  version: string;
  packagePath: string;
  globalRootPath: string | null;
  isLinked: boolean;
}

export interface NpmGlobalPaseoCli {
  inspect(): Promise<NpmGlobalPaseoInstall>;
  installLatest(): Promise<CommandResult>;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

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

function parseNpmGlobalPaseoInstall(stdout: string): NpmGlobalPaseoInstall | null {
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

  const rawCliPackage = list.data.dependencies?.[PASEO_CLI_PACKAGE];
  const cliPackage = NpmGlobalCliPackageSchema.safeParse(rawCliPackage);
  if (!cliPackage.success) {
    return null;
  }

  return {
    version: cliPackage.data.version,
    packagePath: cliPackage.data.path,
    globalRootPath: list.data.path ?? null,
    isLinked: cliPackage.data.link === true,
  };
}

export class DefaultNpmGlobalPaseoCli implements NpmGlobalPaseoCli {
  constructor(private readonly runCommand: CommandRunner = runExternalCommand) {}

  async inspect(): Promise<NpmGlobalPaseoInstall> {
    const result = await this.runCommand(
      "npm",
      ["-g", "ls", PASEO_CLI_PACKAGE, "--json", "--depth=0", "--long"],
      {
        timeout: NPM_PROBE_TIMEOUT_MS,
        maxBuffer: NPM_MAX_BUFFER_BYTES,
      },
    );

    if (result.exitCode !== 0 && result.stdout.trim().length === 0) {
      throw new Error(result.stderr.trim() || "npm is not available on this host");
    }

    const install = parseNpmGlobalPaseoInstall(result.stdout);
    if (!install) {
      throw new Error(`${PASEO_CLI_PACKAGE} is not installed with npm -g on this host`);
    }
    return install;
  }

  installLatest(): Promise<CommandResult> {
    return this.runCommand("npm", ["install", "-g", `${PASEO_CLI_PACKAGE}@latest`], {
      timeout: NPM_INSTALL_TIMEOUT_MS,
      maxBuffer: NPM_MAX_BUFFER_BYTES,
    });
  }
}

export const npmGlobalPaseoCli = new DefaultNpmGlobalPaseoCli();
