import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { CodexAppServerAgentSession } from "../agent/providers/codex-app-server-agent.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";

// The replay methods and native-to-canonical mappers are real. Only their external
// history transport is replaced, so fixtures cannot smuggle a host turnId into Claude.
export async function claudeNativeHistory(records: readonly unknown[]) {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: () => {
      throw new Error("History cannot query a provider");
    },
  });
  const session = await client.createSession({ provider: "claude", cwd: "/tmp/native-history" });
  (
    session as unknown as { ingestPersistedHistory(content: string, ownership: unknown): void }
  ).ingestPersistedHistory(records.map((record) => JSON.stringify(record)).join("\n"), {
    restoredIds: new Set(),
    toolOwners: new Map(),
  });
  const events: AgentStreamEvent[] = [];
  for await (const event of session.streamHistory()) events.push(event);
  await session.close();
  return events;
}

export async function codexNativeHistory(turns: readonly unknown[]) {
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/tmp/native-history" },
    null,
    createTestLogger(),
    () => {
      throw new Error("History cannot spawn a provider");
    },
    {},
    false,
    false,
    false,
  );
  Object.assign(session, {
    connected: true,
    currentThreadId: "native-history",
    client: { request: async () => ({ thread: { turns } }) },
  });
  await (session as unknown as { loadPersistedHistory(): Promise<void> }).loadPersistedHistory();
  const events: AgentStreamEvent[] = [];
  for await (const event of session.streamHistory()) events.push(event);
  return events;
}

function completeNativeMessages(sourceHistory: readonly AgentStreamEvent[]) {
  // The fixture emits streaming chunks; native transcripts save one assistant message.
  const history: AgentStreamEvent[] = [];
  for (const event of sourceHistory) {
    const previous = history.at(-1);
    if (
      event.type === "timeline" &&
      event.item.type === "assistant_message" &&
      previous?.type === "timeline" &&
      previous.item.type === "assistant_message" &&
      previous.turnId === event.turnId &&
      previous.item.messageId === event.item.messageId
    )
      previous.item.text += event.item.text;
    else history.push(structuredClone(event));
  }
  return history;
}

export async function workflowNativeHistory(
  sourceHistory: readonly AgentStreamEvent[],
  provider: "claude" | "codex",
) {
  const history = completeNativeMessages(sourceHistory);
  if (provider === "codex") {
    const turns: Array<{ id?: string; items: unknown[] }> = [];
    for (const event of history) {
      if (event.type !== "timeline") continue;
      if (!turns.length || turns.at(-1)!.id !== event.turnId)
        turns.push({ id: event.turnId, items: [] });
      const item = event.item;
      const id =
        ("messageId" in item ? item.messageId : undefined) ??
        `native-${turns.length}-${turns.at(-1)!.items.length}`;
      if (item.type === "user_message")
        turns
          .at(-1)!
          .items.push({ type: "userMessage", id, content: [{ type: "text", text: item.text }] });
      else if (item.type === "assistant_message")
        turns.at(-1)!.items.push({ type: "agentMessage", id, text: item.text });
      else if (item.type === "tool_call" && item.detail.type === "plan")
        turns.at(-1)!.items.push({ type: "plan", id: item.callId, text: item.detail.text });
    }
    return codexNativeHistory(turns);
  }
  const records: unknown[] = [];
  for (const event of history) {
    if (event.type !== "timeline") continue;
    const item = event.item;
    const uuid = ("messageId" in item ? item.messageId : undefined) ?? `native-${records.length}`;
    if (item.type === "user_message")
      records.push({ type: "user", uuid, message: { role: "user", content: item.text } });
    else if (item.type === "assistant_message")
      records.push({
        type: "assistant",
        uuid,
        message: { role: "assistant", content: [{ type: "text", text: item.text }] },
      });
    else if (item.type === "tool_call" && item.detail.type === "plan")
      records.push({
        type: "assistant",
        uuid,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: item.callId,
              name: "ExitPlanMode",
              input: { plan: item.detail.text },
            },
          ],
        },
      });
  }
  return claudeNativeHistory(records);
}
