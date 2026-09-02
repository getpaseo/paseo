import type { Command } from "commander";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../../utils/client.js";
import { buildDaemonOperationCommandError } from "../../utils/daemon-operation-error.js";

interface WorkspacePinResult {
  workspaceId: string;
  pinned: boolean;
  pinnedAt: string | null;
}

const workspacePinSchema: OutputSchema<WorkspacePinResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "PINNED", field: "pinned", width: 8 },
    { header: "PINNED AT", field: "pinnedAt", width: 26 },
  ],
};

async function runSetWorkspacePinnedCommand(input: {
  workspaceId: string;
  pinned: boolean;
  host?: string;
}): Promise<SingleResult<WorkspacePinResult>> {
  const client = await connectToDaemon({ host: input.host }).catch((error: unknown) => {
    throw buildDaemonConnectionCommandError({ host: input.host, error });
  });

  try {
    // COMPAT(workspacePinning): added in v0.1.107, remove gate after 2027-01-12.
    if (client.getLastServerInfoMessage()?.features?.workspacePinning !== true) {
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to use workspace pinning.",
        details: "The connected daemon does not advertise workspace pinning support.",
      } satisfies CommandError;
    }

    const payload = await client.setWorkspacePinned(input.workspaceId, input.pinned);
    return {
      type: "single",
      data: { workspaceId: input.workspaceId, pinned: input.pinned, pinnedAt: payload.pinnedAt },
      schema: workspacePinSchema,
    };
  } catch (error) {
    throw buildDaemonOperationCommandError({
      code: input.pinned ? "WORKSPACE_PIN_FAILED" : "WORKSPACE_UNPIN_FAILED",
      action: `${input.pinned ? "pin" : "unpin"} workspace`,
      error,
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function runPinCommand(
  workspaceId: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<WorkspacePinResult>> {
  return runSetWorkspacePinnedCommand({ workspaceId, pinned: true, host: options.host });
}

export async function runUnpinCommand(
  workspaceId: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<WorkspacePinResult>> {
  return runSetWorkspacePinnedCommand({ workspaceId, pinned: false, host: options.host });
}
