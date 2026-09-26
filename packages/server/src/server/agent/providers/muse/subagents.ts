import type { AgentProvider, AgentStreamEvent } from "../../agent-sdk-types.js";
import type { ProviderSubagentStatus } from "../../provider-subagents/store.js";
import { isRecord, type MuseViewItem } from "./items.js";

/**
 * Map MSP child items (`subagent`, `reminderChild`, `workflow`) to
 * `provider_subagent` track events. Upserts are idempotent across revisions;
 * the result timeline row fires only on a terminal frame carrying a result
 * envelope, so replaying history never duplicates the live emission.
 */
export function mapMuseSubagentEvents(
  item: MuseViewItem,
  provider: AgentProvider,
  options?: { terminal?: boolean },
): AgentStreamEvent[] {
  switch (item.kind) {
    case "subagent":
      return mapSubagentItem(item, provider, options?.terminal ?? false);
    case "reminderChild":
      return mapReminderChildItem(item, provider);
    case "workflow":
      return mapWorkflowItem(item, provider);
    default:
      return [];
  }
}

function mapSubagentItem(
  item: MuseViewItem,
  provider: AgentProvider,
  terminal: boolean,
): AgentStreamEvent[] {
  const id = readText(item.subagentId) ?? item.itemId;
  const events: AgentStreamEvent[] = [
    {
      type: "provider_subagent",
      provider,
      event: {
        type: "upsert",
        id,
        title: readText(item.role) ?? "Muse subagent",
        description: readText(item.objective) ?? readText(item.fallbackText) ?? null,
        ...readStatus(item.status),
      },
    },
  ];
  if (terminal) {
    const resultText = readResultText(item.result);
    if (resultText) {
      events.push({
        type: "provider_subagent",
        provider,
        event: {
          type: "timeline",
          id,
          item: { type: "assistant_message", text: resultText, messageId: item.itemId },
        },
      });
    }
  }
  return events;
}

function mapReminderChildItem(item: MuseViewItem, provider: AgentProvider): AgentStreamEvent[] {
  return [
    {
      type: "provider_subagent",
      provider,
      event: {
        type: "upsert",
        id: readText(item.childSessionId) ?? item.itemId,
        title: readText(item.fallbackText) ?? "Reminder",
        description: readText(item.reminderAgentId) ?? null,
        ...readStatus(item.status),
      },
    },
  ];
}

function mapWorkflowItem(item: MuseViewItem, provider: AgentProvider): AgentStreamEvent[] {
  return [
    {
      type: "provider_subagent",
      provider,
      event: {
        type: "upsert",
        id: readText(item.workflowRunId) ?? item.itemId,
        title:
          readText(item.scriptId) ??
          readText(item.entryId) ??
          readText(item.fallbackText) ??
          "Workflow",
        description: readText(item.message) ?? null,
        ...readStatus(item.status),
      },
    },
  ];
}

function readStatus(status: unknown): { status?: ProviderSubagentStatus } {
  if (status === "inProgress") {
    return { status: "running" };
  }
  if (status === "completed") {
    return { status: "completed" };
  }
  if (status === "cancelled") {
    return { status: "canceled" };
  }
  if (status === "failed" || status === "rejected" || status === "timedOut") {
    return { status: "failed" };
  }
  // Terminal-unknown per the wire contract: keep the stored status rather
  // than report a state the server never stated.
  return {};
}

function readResultText(result: unknown): string | null {
  if (!isRecord(result)) {
    return null;
  }
  return readText(result["text"]) ?? readText(result["summary"]);
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text.length > 0 ? value : null;
}
