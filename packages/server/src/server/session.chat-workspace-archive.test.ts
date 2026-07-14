import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import {
  createChatWorkspaceTestFixture,
  disposeChatWorkspaceTestFixture,
} from "./test-utils/chat-workspace-fixture.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";

function createArchiveFixture() {
  return createChatWorkspaceTestFixture({
    workdirPrefix: "paseo-chat-workspace-archive-",
    clientId: "chat-workspace-archive-test-client",
    sessionId: "chat-workspace-archive-test-session",
    agentId: "00000000-0000-4000-8000-000000000662",
  });
}

const disposeArchiveFixture = disposeChatWorkspaceTestFixture;

test("archiving a chat workspace deletes its scratch directory from disk", async () => {
  const fixture = createArchiveFixture();
  try {
    await fixture.session.handleMessage({
      type: "create_agent_request",
      requestId: "req-create-chat-archive",
      chatWorkspace: true,
      config: { provider: "codex", cwd: "" },
      attachments: [],
    });

    const workspaces = await fixture.workspaceRegistry.list();
    const chatWorkspace = workspaces[0];
    if (!chatWorkspace) {
      throw new Error("Expected a chat workspace to be created");
    }
    expect(existsSync(chatWorkspace.cwd)).toBe(true);

    await fixture.session.handleMessage({
      type: "archive_workspace_request",
      workspaceId: chatWorkspace.workspaceId,
      requestId: "req-archive-chat",
    });

    const response = fixture.emitted.find(
      (message) => message.type === "archive_workspace_response",
    );
    expect(response).toMatchObject({
      payload: { requestId: "req-archive-chat", error: null },
    });
    expect(existsSync(chatWorkspace.cwd)).toBe(false);
  } finally {
    await disposeArchiveFixture(fixture);
  }
});

test("archiving a normal workspace does not delete its directory", async () => {
  const fixture = createArchiveFixture();
  try {
    const projectDir = mkdtempSync(path.join(tmpdir(), "paseo-normal-workspace-"));
    const now = "2026-03-01T12:00:00.000Z";
    const project = createPersistedProjectRecord({
      projectId: projectDir,
      rootPath: projectDir,
      kind: "non_git",
      displayName: "normal-project",
      createdAt: now,
      updatedAt: now,
    });
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: projectDir,
      projectId: projectDir,
      cwd: projectDir,
      kind: "directory",
      displayName: "normal-project",
      createdAt: now,
      updatedAt: now,
    });
    await fixture.projectRegistry.upsert(project);
    await fixture.workspaceRegistry.upsert(workspace);

    try {
      await fixture.session.handleMessage({
        type: "archive_workspace_request",
        workspaceId: workspace.workspaceId,
        requestId: "req-archive-normal",
      });

      const response = fixture.emitted.find(
        (message) => message.type === "archive_workspace_response",
      );
      expect(response).toMatchObject({
        payload: { requestId: "req-archive-normal", error: null },
      });
      expect(existsSync(projectDir)).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  } finally {
    await disposeArchiveFixture(fixture);
  }
});
