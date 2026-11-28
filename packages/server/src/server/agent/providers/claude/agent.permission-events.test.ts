import { expect, test } from "vitest";
import type { CanUseTool, Query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";

// Drive the SDK's permission callback through the injected query dependency.
// Subscribers and permission state use the real AgentSession implementation.
test.each([
  ["Bash", { command: "echo permission" }],
  ["AskUserQuestion", { questions: [{ question: "Proceed?", header: "Proceed" }] }],
  ["ExitPlanMode", { plan: "Implement the plan" }],
])("a subscriber can immediately deny %s", async (toolName, input) => {
  let requestPermission: CanUseTool | undefined;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const query = {
    async next() {
      await finished;
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    close: finish,
  };
  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude",
    queryFactory: ({ options }) => {
      requestPermission = options.canUseTool;
      return query as Query;
    },
  }).createSession({ provider: "claude", cwd: process.cwd(), modeId: "default" });
  const events: AgentStreamEvent[] = [];
  let response: Promise<void> | undefined;
  let pendingAtPublication: string[] = [];
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "permission_requested") {
      pendingAtPublication = session.getPendingPermissions().map((request) => request.id);
      response = session.respondToPermission(event.request.id, {
        behavior: "deny",
        message: "Denied immediately",
      });
      void response.catch(() => undefined);
    }
  });
  try {
    await session.startTurn("Request permission");
    if (!requestPermission) throw new Error("SDK permission callback was not configured");
    const result = requestPermission(toolName, input, {
      signal: new AbortController().signal,
      toolUseID: "permission-tool-call",
    });
    void result.catch(() => undefined);
    expect(response).toBeDefined();
    await expect(response).resolves.toBeUndefined();
    await expect(result).resolves.toMatchObject({
      behavior: "deny",
      message: "Denied immediately",
    });
    const requested = events.find((event) => event.type === "permission_requested");
    if (requested?.type !== "permission_requested") throw new Error("No permission event");
    expect(pendingAtPublication).toContain(requested.request.id);
    expect(session.getPendingPermissions()).toEqual([]);
    expect(
      events
        .filter(
          (event) => event.type === "permission_requested" || event.type === "permission_resolved",
        )
        .map((event) => event.type),
    ).toEqual(["permission_requested", "permission_resolved"]);
  } finally {
    await session.close();
  }
});
