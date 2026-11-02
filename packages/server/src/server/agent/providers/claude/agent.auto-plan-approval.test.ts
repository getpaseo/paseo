import { expect, test } from "vitest";
import type { CanUseTool, PermissionMode, Query } from "@anthropic-ai/claude-agent-sdk";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentPermissionRequest } from "../../agent-sdk-types.js";
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
