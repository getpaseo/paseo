import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

import { resolveChatsRoot } from "./chat-workspace/scratch-dir.js";
import {
  createChatWorkspaceTestFixture,
  disposeChatWorkspaceTestFixture,
} from "./test-utils/chat-workspace-fixture.js";

function createChatWorkspaceFixture() {
  return createChatWorkspaceTestFixture({
    workdirPrefix: "paseo-chat-workspace-",
    clientId: "chat-workspace-test-client",
    sessionId: "chat-workspace-test-session",
    agentId: "00000000-0000-4000-8000-000000000661",
  });
}

const disposeChatWorkspaceFixture = disposeChatWorkspaceTestFixture;

test("create_agent_request creates a scratch-backed chat workspace", async () => {
  const fixture = createChatWorkspaceFixture();
  try {
    await fixture.session.handleMessage({
      type: "create_agent_request",
      requestId: "req-create-chat",
      chatWorkspace: true,
      config: { provider: "codex", cwd: "" },
      attachments: [],
    });

    const [createdAgent] = fixture.agentManager.listAgents();
    if (!createdAgent || !createdAgent.workspaceId) {
      throw new Error("Expected chat agent with a workspace");
    }

    expect(path.dirname(createdAgent.cwd)).toBe(resolveChatsRoot(fixture.paseoHome));
    expect(path.basename(createdAgent.cwd)).toMatch(/^chat-[0-9a-f]+$/);
    expect(existsSync(createdAgent.cwd)).toBe(true);

    const workspace = await fixture.workspaceRegistry.get(createdAgent.workspaceId);
    expect(workspace).toMatchObject({ cwd: createdAgent.cwd });
    expect(
      fixture.emitted.find(
        (message) => message.type === "status" && message.payload.status === "agent_created",
      ),
    ).toMatchObject({
      payload: {
        status: "agent_created",
        requestId: "req-create-chat",
        agent: { cwd: createdAgent.cwd },
      },
    });
  } finally {
    await disposeChatWorkspaceFixture(fixture);
  }
});

test.each([
  {
    name: "worktree",
    conflict: {
      worktree: {
        mode: "branch-off" as const,
        newBranch: "chat-conflict",
        base: "main",
      },
    },
  },
  {
    name: "workspaceId",
    conflict: { workspaceId: "ws-existing" },
  },
  {
    name: "callerAgentId",
    conflict: { callerAgentId: "agent-existing" },
  },
  {
    name: "legacy worktreeName",
    conflict: { worktreeName: "chat-conflict" },
  },
])("create_agent_request rejects chatWorkspace combined with $name", async ({ conflict }) => {
  const fixture = createChatWorkspaceFixture();
  try {
    await fixture.session.handleMessage({
      type: "create_agent_request",
      requestId: "req-reject-chat",
      chatWorkspace: true,
      config: { provider: "codex", cwd: "" },
      attachments: [],
      ...conflict,
    });

    expect(fixture.agentManager.listAgents()).toEqual([]);
    expect(await fixture.workspaceRegistry.list()).toEqual([]);
    expect(existsSync(resolveChatsRoot(fixture.paseoHome))).toBe(false);
    expect(
      fixture.emitted.find(
        (message) => message.type === "status" && message.payload.status === "agent_create_failed",
      ),
    ).toMatchObject({
      payload: {
        status: "agent_create_failed",
        requestId: "req-reject-chat",
        error: expect.stringContaining("chatWorkspace cannot be combined"),
      },
    });
  } finally {
    await disposeChatWorkspaceFixture(fixture);
  }
});
