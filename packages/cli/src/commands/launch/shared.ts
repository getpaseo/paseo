import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { DaemonTarget } from "../../utils/daemon-target.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError } from "../../output/index.js";
import {
  resolveWorkspaceScriptWorkspaceId,
  toWorkspaceScriptCommandError,
  type WorkspaceScriptCommandOptions,
} from "../script/shared.js";

export type WorkspaceLaunchCommandOptions = WorkspaceScriptCommandOptions;

export async function connectWorkspaceLaunchClient(target: DaemonTarget): Promise<DaemonClient> {
  const daemonHost = getDaemonHost({ target });
  try {
    const client = await connectToDaemon({ target });
    // COMPAT(workspaceLaunchManagement): added in v0.7.0, remove gate after 2027-08-29.
    if (!client.getLastServerInfoMessage()?.features?.workspaceLaunchManagement) {
      await client.close().catch(() => {});
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to use workspace launch management.",
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
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

export const resolveWorkspaceLaunchWorkspaceId = resolveWorkspaceScriptWorkspaceId;
export const toWorkspaceLaunchCommandError = toWorkspaceScriptCommandError;
