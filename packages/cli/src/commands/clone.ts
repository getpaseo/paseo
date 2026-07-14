import type { Command } from "commander";
import { isCompleteGitRemote } from "@getpaseo/protocol/git-remote";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../output/index.js";
import type { CommandOptions } from "../output/with-output.js";

type CloneProtocol = "https" | "ssh";

interface CloneCommandOptions extends CommandOptions {
  protocol?: CloneProtocol;
}

export interface CloneResult {
  repo: string;
  checkoutPath: string;
  workspaceId: string;
  workspaceName: string;
}

export const cloneSchema: OutputSchema<CloneResult> = {
  idField: "workspaceId",
  columns: [
    { header: "REPO", field: "repo", width: 28 },
    { header: "WORKSPACE", field: "workspaceName", width: 28 },
    { header: "PATH", field: "checkoutPath", width: 56 },
  ],
};

function cmdError(code: string, message: string, details?: string): CommandError {
  return details ? { code, message, details } : { code, message };
}

export async function runCloneCommand(
  repo: string,
  options: CloneCommandOptions,
  _command: Command,
): Promise<SingleResult<CloneResult>> {
  const targetDirectory = typeof options.dir === "string" ? options.dir.trim() : "";
  if (!targetDirectory) {
    throw cmdError("INVALID_ARGUMENT", "--dir is required");
  }
  const repoIsCompleteRemote = isCompleteGitRemote(repo);
  if (!repoIsCompleteRemote && !options.protocol) {
    throw cmdError("INVALID_ARGUMENT", "--protocol is required for owner/repo repository names");
  }

  let client: DaemonClient;
  try {
    client = await connectToDaemon({ host: options.host });
  } catch (err) {
    throw buildDaemonConnectionCommandError({ host: options.host, error: err });
  }

  if (client.getLastServerInfoMessage()?.features?.workspaceGithubClone !== true) {
    await client.close().catch(() => {});
    throw cmdError(
      "UNSUPPORTED_BY_HOST",
      "This daemon does not support cloning GitHub repos.",
      "Update the host to a newer Paseo version.",
    );
  }

  try {
    const response = await client.cloneGithubWorkspace({
      repo,
      targetDirectory,
      ...(repoIsCompleteRemote ? {} : { cloneProtocol: options.protocol }),
    });
    if (response.error || !response.workspace || !response.checkoutPath) {
      throw cmdError(
        "CLONE_FAILED",
        `Failed to clone GitHub repo: ${response.error ?? "no workspace returned"}`,
      );
    }

    return {
      type: "single",
      data: {
        repo: response.repo,
        checkoutPath: response.checkoutPath,
        workspaceId: response.workspace.id,
        workspaceName: response.workspace.name,
      },
      schema: cloneSchema,
    };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw cmdError("CLONE_FAILED", `Failed to clone GitHub repo: ${message}`);
  } finally {
    await client.close().catch(() => {});
  }
}
