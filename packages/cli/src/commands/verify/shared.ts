import { resolve } from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CommandError, CommandOptions } from "../../output/index.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";

export interface VerifyCommandOptions extends CommandOptions {
  host?: string;
  cwd?: string;
  workspace?: string;
  param?: string[];
}

export async function connectVerifyClient(target: DaemonTarget): Promise<DaemonClient> {
  const daemonHost = getDaemonHost({ target });
  try {
    const client = await connectToDaemon({ target });
    // COMPAT(verifyRecipes): added in v0.8.0, remove gate after 2027-09-17.
    if (!client.getLastServerInfoMessage()?.features?.verifyRecipes) {
      await client.close().catch(() => {});
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to run verify recipes.",
      } satisfies CommandError;
    }
    return client;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && "message" in error) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${daemonHost}: ${message}`,
      details: "Start the daemon with: pandaos daemon start",
    } satisfies CommandError;
  }
}

export async function resolveVerifyWorkspaceId(
  client: DaemonClient,
  options: VerifyCommandOptions,
): Promise<string> {
  if (options.workspace) {
    return options.workspace;
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const payload = await client.fetchWorkspaces({ page: { limit: 200 } });
  const matches = payload.entries.filter(
    (workspace) => resolve(workspace.workspaceDirectory) === cwd,
  );
  if (matches.length === 1) {
    return matches[0]!.id;
  }
  if (matches.length > 1) {
    throw {
      code: "WORKSPACE_AMBIGUOUS",
      message: `Multiple workspaces use ${cwd}`,
      details: "Pass --workspace <workspace-id> to select one.",
    } satisfies CommandError;
  }
  throw {
    code: "WORKSPACE_NOT_FOUND",
    message: `No Paseo workspace found for ${cwd}`,
    details: "Open the directory in Paseo first, or pass --workspace <workspace-id>.",
  } satisfies CommandError;
}

/** Parses repeated `--param name=value` flags into the recipe parameter record. */
export function parseVerifyParams(values: string[] | undefined): Record<string, string> {
  const params: Record<string, string> = {};
  for (const value of values ?? []) {
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw {
        code: "VERIFY_PARAM_INVALID",
        message: `Cannot read parameter ${value}`,
        details: "Write parameters as --param name=value.",
      } satisfies CommandError;
    }
    params[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return params;
}

export function toVerifyCommandError(code: string, action: string, error: unknown): CommandError {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    return error as CommandError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code, message: `Failed to ${action}: ${message}` };
}
