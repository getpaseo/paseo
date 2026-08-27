import { describe, expect, test } from "vitest";

import type { AgentSession, AgentStreamEvent } from "../agent-sdk-types.js";
import { MockLoadTestAgentClient } from "./mock-load-test-agent.js";

async function createIdleSessionWithProviderUserMessage(): Promise<{
  session: AgentSession;
  messageId: string;
}> {
  const client = new MockLoadTestAgentClient();
  const session = await client.createSession({
    provider: "mock",
    cwd: process.cwd(),
    model: "ten-second-stream",
  });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  await session.startTurn("Emit synthetic user message before accepting turn.");
  await session.interrupt();

  const userMessage = events.find(
    (event) => event.type === "timeline" && event.item.type === "user_message",
  );
  if (userMessage?.type !== "timeline" || userMessage.item.type !== "user_message") {
    throw new Error("Mock provider user message was not emitted");
  }
  if (!userMessage.item.messageId) {
    throw new Error("Mock provider user message ID was not emitted");
  }
  return { session, messageId: userMessage.item.messageId };
}

function requireRewindCapabilities(session: AgentSession): {
  conversation: NonNullable<AgentSession["revertConversation"]>;
  files: NonNullable<AgentSession["revertFiles"]>;
  both: NonNullable<AgentSession["revertBoth"]>;
} {
  if (!session.revertConversation || !session.revertFiles || !session.revertBoth) {
    throw new Error("Mock provider rewind capabilities are unavailable");
  }
  return {
    conversation: session.revertConversation.bind(session),
    files: session.revertFiles.bind(session),
    both: session.revertBoth.bind(session),
  };
}

describe("MockLoadTestAgentSession rewind", () => {
  test("rejects unknown targets and accepts a provider-owned user message", async () => {
    const { session, messageId } = await createIdleSessionWithProviderUserMessage();
    const rewind = requireRewindCapabilities(session);

    await expect(rewind.conversation({ messageId: "unknown-message" })).rejects.toThrow(
      "Mock rewind target unknown-message was not found in session history",
    );
    await expect(rewind.files({ messageId: "unknown-message" })).rejects.toThrow(
      "Mock rewind target unknown-message was not found in session history",
    );
    await expect(rewind.both({ messageId: "unknown-message" })).rejects.toThrow(
      "Mock rewind target unknown-message was not found in session history",
    );

    await expect(rewind.files({ messageId })).resolves.toBeUndefined();
    await expect(rewind.conversation({ messageId })).resolves.toBeUndefined();
    await expect(rewind.both({ messageId })).resolves.toBeUndefined();
    await session.close();
  });
});
