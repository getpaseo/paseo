import { expect, test } from "vitest";
import type { CanUseTool, PermissionMode, Query } from "@anthropic-ai/claude-agent-sdk";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentPermissionRequest, AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";

// The injected SDK adapter supplies requests through Claude's permission callback.
async function createPlanApproval(mode: PermissionMode) {
  let requestPermission: CanUseTool | undefined;
  let sdkMode: PermissionMode = mode;
  const query = Object.assign((async function* () {})(), {
    async setPermissionMode(next: PermissionMode) {
      sdkMode = next;
    },
    close() {},
  });
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude",
    queryFactory: ({ options }) => {
      requestPermission = options.canUseTool;
      return query as Query;
    },
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    modeId: mode,
  });
  let request: AgentPermissionRequest | undefined;
  session.subscribe((event) => {
    if (event.type === "permission_requested") request = event.request;
  });
  await session.setMode("plan");
  if (!requestPermission) throw new Error("SDK permission callback was not installed");
  const resolution = requestPermission(
    "ExitPlanMode",
    { plan: "Implement the plan" },
    {
      signal: new AbortController().signal,
      toolUseID: "plan-approval",
    },
  );
  if (!request) throw new Error("No plan approval request was emitted");
  return { session, request, resolution, sdkMode: () => sdkMode };
}

test.each([
  ["auto", "Implement with Auto mode"],
  ["bypassPermissions", "Implement with Bypass"],
] as const)("plan approval offers an explicit return to %s", async (mode, label) => {
  const plan = await createPlanApproval(mode);
  try {
    expect(plan.request.actions).toContainEqual(
      expect.objectContaining({
        id: "implement_resume",
        label,
        behavior: "allow",
        intent: "implement_resume",
      }),
    );
  } finally {
    await plan.session.respondToPermission(plan.request.id, { behavior: "deny" });
    await plan.resolution;
    await plan.session.close();
  }
});

test.each([
  ["auto", "implement_resume", "auto"],
  ["bypassPermissions", "implement_resume", "bypassPermissions"],
  ["auto", "implement", "acceptEdits"],
  ["bypassPermissions", "implement", "acceptEdits"],
  ["default", "implement_resume", "acceptEdits"],
  ["acceptEdits", "implement_resume", "acceptEdits"],
] as const)("approving from %s with %s enters %s", async (mode, action, expected) => {
  const plan = await createPlanApproval(mode);
  try {
    await plan.session.respondToPermission(plan.request.id, {
      behavior: "allow",
      selectedActionId: action,
    });
    await expect(plan.resolution).resolves.toMatchObject({ behavior: "allow" });
    expect(plan.sdkMode()).toBe(expected);
    expect(await plan.session.getCurrentMode()).toBe(expected);
    if (mode === "default" || mode === "acceptEdits") {
      expect(plan.request.actions?.some((entry) => entry.id === "implement_resume")).toBe(false);
    }
  } finally {
    await plan.session.close();
  }
});

test("bypass allows execution without publishing permission events and follows live mode changes", async () => {
  let requestPermission: CanUseTool | undefined;
  const query = Object.assign((async function* () {})(), {
    async setPermissionMode(_mode: PermissionMode) {},
    close() {},
  });
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude",
    queryFactory: ({ options }) => {
      requestPermission = options.canUseTool;
      return query as Query;
    },
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    modeId: "bypassPermissions",
  });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.setMode("bypassPermissions");
    if (!requestPermission) throw new Error("SDK permission callback was not installed");
    const controller = new AbortController();
    const input = { command: "echo hello" };
    const result = requestPermission("Bash", input, {
      signal: controller.signal,
      toolUseID: "execution",
      decisionReason: "Explicit ask rule",
    });
    // Abort also settles the pre-fix callback, so this repro never hangs.
    controller.abort();
    await expect(result).resolves.toMatchObject({ behavior: "allow", updatedInput: input });
    expect(events.filter((event) => event.type.startsWith("permission_"))).toEqual([]);

    for (const [mode, tool, toolInput] of [
      ["bypassPermissions", "AskUserQuestion", { questions: [] }],
      ["bypassPermissions", "ExitPlanMode", { plan: "Review this" }],
      ["default", "Bash", input],
      ["plan", "Bash", input],
    ] as const) {
      await session.setMode(mode);
      const resolution = requestPermission(tool, toolInput, {
        signal: new AbortController().signal,
        toolUseID: tool,
      });
      const requestEvent = events.at(-1);
      expect(requestEvent?.type).toBe("permission_requested");
      if (requestEvent?.type !== "permission_requested")
        throw new Error("Missing permission request");
      await session.respondToPermission(requestEvent.request.id, { behavior: "deny" });
      await expect(resolution).resolves.toMatchObject({ behavior: "deny" });
    }
  } finally {
    await session.close();
  }
});
