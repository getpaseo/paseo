import type { Logger } from "pino";
import type { BrowserHandoff } from "@getpaseo/protocol/browser-activity/rpc-schemas";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { formatSystemNotificationPrompt, sendPromptToAgent } from "../agent/agent-prompt.js";
import type { BrowserActivityHub } from "./browser-activity.js";
import type { BrowserToolsBroker, BrowserToolsExecuteInput } from "./broker.js";
import type { RegisterBrowserToolsOptions } from "./tools.js";

export interface BrowserHandoffFollowUpDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  broker: Pick<BrowserToolsBroker, "execute">;
  logger: Logger;
}

interface GuardedBrowserTools {
  broker: Pick<BrowserToolsBroker, "execute">;
  handoff?: RegisterBrowserToolsOptions["handoff"];
}

/**
 * The broker an agent's browser tools use: it refuses handed-off tabs. The handoff tool itself
 * needs a calling agent, since only an agent can receive the follow-up.
 */
export function guardBrowserToolsForHandoffs(input: {
  broker: BrowserToolsBroker;
  hub: BrowserActivityHub | undefined;
  callerAgentId: string | undefined;
  followUp: Omit<BrowserHandoffFollowUpDependencies, "broker">;
}): GuardedBrowserTools {
  const { broker, hub } = input;
  if (!hub) return { broker };
  const guarded = {
    execute: hub.guard((request: BrowserToolsExecuteInput) => broker.execute(request)),
  };
  if (!input.callerAgentId) return { broker: guarded };
  const deps = { ...input.followUp, broker };
  return {
    broker: guarded,
    handoff: {
      hub,
      onEnd: (handoff) => {
        sendBrowserHandoffFollowUp(handoff, deps).catch((error: unknown) => {
          deps.logger.error(
            { err: error, agentId: handoff.agentId, browserId: handoff.browserId },
            "Failed to send browser handoff follow-up",
          );
        });
      },
    },
  };
}

/**
 * Tells the agent that asked for a handoff how it ended: a note in its timeline for the user,
 * and a system prompt steered into the agent, so a busy agent is not interrupted.
 */
export async function sendBrowserHandoffFollowUp(
  handoff: BrowserHandoff,
  deps: BrowserHandoffFollowUpDependencies,
): Promise<void> {
  const record = await deps.agentStorage.get(handoff.agentId);
  if (record?.archivedAt) return;
  const note = describeBrowserHandoffEnd(handoff, await isHandoffTabOpen(handoff, deps.broker));
  await ensureAgentLoaded(handoff.agentId, deps);
  await deps.agentManager.appendTimelineItem(handoff.agentId, {
    type: "notification",
    level: "info",
    message: note,
  });
  await sendPromptToAgent({
    agentManager: deps.agentManager,
    agentStorage: deps.agentStorage,
    agentId: handoff.agentId,
    prompt: formatSystemNotificationPrompt(
      `${note}\nbrowserId=${handoff.browserId}. Browser tools work on this tab again.`,
    ),
    activeTurnBehavior: "steer",
    unarchive: false,
    logger: deps.logger,
  });
}

export function describeBrowserHandoffEnd(handoff: BrowserHandoff, tabIsOpen: boolean): string {
  const verb = handoff.status === "done" ? "finished" : "cancelled";
  const state = tabIsOpen
    ? "The tab is available for browser tools again; take a fresh snapshot before continuing."
    : "The tab is closed.";
  return `The user ${verb} the browser handoff "${handoff.reason}". ${state}`;
}

async function isHandoffTabOpen(
  handoff: BrowserHandoff,
  broker: Pick<BrowserToolsBroker, "execute">,
): Promise<boolean> {
  const payload = await broker.execute({
    workspaceId: handoff.workspaceId,
    command: { command: "list_tabs", args: {} },
  });
  return (
    payload.ok &&
    payload.result.command === "list_tabs" &&
    payload.result.tabs.some((tab) => tab.browserId === handoff.browserId)
  );
}
