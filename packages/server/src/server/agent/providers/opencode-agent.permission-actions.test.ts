import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  idleEvent,
  TestOpenCodeClient,
  TestOpenCodeRuntime,
} from "./opencode/test-utils/test-opencode-runtime.js";

function mockOpenCodeClient(events: unknown[]) {
  const runtime = new TestOpenCodeRuntime();
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
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });
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
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });
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
