import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import type { V2Api } from "./api.js";
import { OpenCodeV2AgentClient } from "./agent.js";
import { V2Harness } from "../test-utils/v2-harness.js";

describe("OpenCode v2 questions", () => {
  test("maps selected labels to native values and parses numeric and boolean answers", async () => {
    const harness = new V2Harness();
    harness.api.session.form.list = async () => [
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
    const answers: Parameters<V2Api["session"]["form"]["reply"]>[0][] = [];
    harness.api.session.form.reply = async (input) => {
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

describe("OpenCode v2 permission routing", () => {
  test("routes a child approval back to its owning session", async () => {
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
      expect(replies).toEqual([
        { sessionID: "child", requestID: "child-permission", decision: "once" },
      ]);
    } finally {
      await session.close();
    }
  });

  test("clears an approval resolved by another native client", async () => {
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
});
