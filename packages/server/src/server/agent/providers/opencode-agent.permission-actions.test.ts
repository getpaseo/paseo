import { OpenCodeV2AgentClient } from "./opencode/v2/agent.js";
import { V2Harness } from "./opencode/test-utils/v2-harness.js";
import type { V2Api } from "./opencode/v2/api.js";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  idleEvent,
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";

function mockOpenCodeClient(events: unknown[]) {
  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.sessionPromptAsyncEvents = events;
  runtime.enqueueClient(openCodeClient);

  return { openCodeClient, runtime };
}

function toolPermissionEvent(): unknown {
  return {
    type: "permission.asked",
    properties: {
      id: "permission-1",
      sessionID: "session-1",
      permission: "external_directory",
      patterns: ["/tmp/outside/*"],
      metadata: {
        reason: "Inspect files outside the project",
      },
    },
  };
}

describe("OpenCode permission actions", () => {
  test("allow always sends OpenCode's always reply", async () => {
    const { openCodeClient, runtime } = mockOpenCodeClient([toolPermissionEvent(), idleEvent()]);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({
      provider: "opencode",
      cwd: "/tmp/project",
      modeId: "build",
    });

    await session.run("Inspect outside files");
    const permission = session.getPendingPermissions()[0]!;
    await session.respondToPermission(permission.id, {
      behavior: "allow",
      selectedActionId: "allow_always",
    });

    expect(openCodeClient.calls.permissionReply).toEqual([
      {
        requestID: "permission-1",
        directory: "/tmp/project",
        reply: "always",
      },
    ]);
    expect(session.getPendingPermissions()).toEqual([]);

    await session.close();
  });

  test("plain allow keeps the backward-compatible once reply", async () => {
    const { openCodeClient, runtime } = mockOpenCodeClient([toolPermissionEvent(), idleEvent()]);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({
      provider: "opencode",
      cwd: "/tmp/project",
      modeId: "build",
    });

    await session.run("Inspect outside files");
    const permission = session.getPendingPermissions()[0]!;
    await session.respondToPermission(permission.id, {
      behavior: "allow",
    });

    expect(openCodeClient.calls.permissionReply).toEqual([
      {
        requestID: "permission-1",
        directory: "/tmp/project",
        reply: "once",
      },
    ]);
    expect(session.getPendingPermissions()).toEqual([]);

    await session.close();
  });
});

describe("OpenCode v2 questions", () => {
  test("maps selected labels to native values and parses numeric and boolean answers", async () => {
    const harness = new V2Harness();
    harness.api.form.list = async () => [
      {
        id: "question",
        sessionID: "session",
        title: "Preferences",
        fields: [
          { key: "color", type: "string", options: [{ label: "Blue", value: "blue-id" }] },
          {
            key: "features",
            type: "multiselect",
            options: [{ label: "Search", value: "search-id" }],
          },
          { key: "count", type: "integer" },
          { key: "enabled", type: "boolean" },
        ],
      },
    ];
    const answers: Parameters<V2Api["form"]["reply"]>[0][] = [];
    harness.api.form.reply = async (input) => {
      answers.push(input);
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      expect(session.getPendingPermissions()).toHaveLength(1);
      await session.respondToPermission("question", {
        behavior: "allow",
        updatedInput: {
          answers: {
            color: "Blue",
            features: ["Search"],
            count: "3",
            enabled: "false",
          },
        },
      });
      expect(answers).toEqual([
        {
          sessionID: "session",
          formID: "question",
          answer: {
            color: "blue-id",
            features: ["search-id"],
            count: 3,
            enabled: false,
          },
        },
      ]);
      expect(session.getPendingPermissions()).toHaveLength(0);
    } finally {
      await session.close();
    }
  });
});

test("OpenCode v2 routes a child approval back to its owning session", async () => {
  const harness = new V2Harness();
  const child = { ...harness.info, id: "child", parentID: "session" };
  harness.api.session.list = async (input) => ({
    data: input?.parentID === "session" ? [child] : [],
    cursor: {},
  });
  harness.api.permission.list = async (input) =>
    input.sessionID === "child"
      ? [{ id: "child-permission", sessionID: "child", action: "shell", resources: ["pwd"] }]
      : [];
  const replies: Parameters<V2Api["permission"]["reply"]>[0][] = [];
  harness.api.permission.reply = async (input) => {
    replies.push(input);
  };
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
  try {
    expect(session.getPendingPermissions()).toHaveLength(1);
    await session.respondToPermission("child-permission", {
      behavior: "allow",
      selectedActionId: "once",
    });
    expect(replies).toEqual([{ sessionID: "child", requestID: "child-permission", reply: "once" }]);
  } finally {
    await session.close();
  }
});

test("OpenCode v2 maps authored native permissions and exact injected MCP grants", async () => {
  const harness = new V2Harness();
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const session = await client.createSession({
    provider: "opencode",
    cwd: "/tmp/project",
    providerOptions: { permission: { bash: { pwd: "allow" }, task: "ask" } },
    toolPolicy: { preapproved: [{ server: "paseo.host", tool: "read/info" }] },
  });
  try {
    expect(harness.creates[0].permissions).toEqual([
      { action: "paseo_host_read_info", resource: "*", effect: "allow" },
      { action: "shell", resource: "pwd", effect: "allow" },
      { action: "subagent", resource: "*", effect: "ask" },
    ]);
  } finally {
    await session.close();
  }
});

test("OpenCode v2 clears an approval resolved by another native client", async () => {
  const harness = new V2Harness();
  harness.api.permission.list = async () => [
    { id: "approval", sessionID: "session", action: "shell", resources: ["pwd"] },
  ];
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
  try {
    expect(session.getPendingPermissions()).toHaveLength(1);
    harness.api.permission.list = async () => [];
    harness.push({
      id: "resolved",
      created: 2,
      type: "permission.replied",
      data: { sessionID: "session", requestID: "approval", reply: "once" },
    });
    await expect.poll(() => session.getPendingPermissions()).toEqual([]);
  } finally {
    await session.close();
  }
});
