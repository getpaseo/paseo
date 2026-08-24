import type {
  BrowserTabExecuteResponse,
  BrowserViewerCommand,
} from "@getpaseo/protocol/browser-automation/client-command";
import type { BrowserAutomationResult } from "@getpaseo/protocol/browser-automation/rpc-schemas";

/**
 * What a mirrored action did. Navigate, back, forward, reload, resize, new tab
 * and close all fail the same three ways, so every caller reads one shape and
 * nobody has to remember which of them rejects and which answers `ok: false`.
 */
export type MirrorCommandOutcome =
  | { status: "ok"; result: BrowserAutomationResult }
  | { status: "disconnected" }
  | { status: "failed"; message: string };

export type MirrorCommandFailure = Exclude<MirrorCommandOutcome, { status: "ok" }>;

/** The slice of the daemon client a mirrored action needs, so tests can hand over a fake. */
export interface BrowserCommandSender {
  runBrowserCommand(input: {
    command: BrowserViewerCommand;
    workspaceId?: string;
  }): Promise<BrowserTabExecuteResponse["payload"]>;
}

export interface RunMirrorCommandInput {
  sender: BrowserCommandSender | null;
  command: BrowserViewerCommand;
  workspaceId: string;
}

/**
 * Runs one mirrored action and reports its outcome. A dropped socket rejects and
 * a host refusal answers `ok: false`; both are failures the user performed on
 * purpose, so neither may be swallowed.
 */
export async function runMirrorCommand(
  input: RunMirrorCommandInput,
): Promise<MirrorCommandOutcome> {
  if (!input.sender) {
    return { status: "disconnected" };
  }
  try {
    const payload = await input.sender.runBrowserCommand({
      command: input.command,
      workspaceId: input.workspaceId,
    });
    if (!payload.ok) {
      return { status: "failed", message: payload.error.message };
    }
    return { status: "ok", result: payload.result };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The sentence to put in front of the user. The host's own message wins when it sent one. */
export function describeMirrorFailure(
  outcome: MirrorCommandFailure,
  disconnectedLabel: string,
): string {
  if (outcome.status === "disconnected") {
    return disconnectedLabel;
  }
  return outcome.message;
}
