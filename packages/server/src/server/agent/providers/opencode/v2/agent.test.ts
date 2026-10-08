import type { FormInfo, ModelInfo, SessionMessageInfo } from "@opencode/client";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import { OpenCodeV2AgentClient } from "./agent.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import type { V2Api } from "./api.js";

function terminalEvents(events: AgentStreamEvent[]) {
  return events.filter(
    (event) =>
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled",
  );
}

function createChildHistoryHarness(failure?: "children" | "messages" | "status") {
  const harness = new V2Harness();
  const child = { ...harness.info, id: "child", parentID: "session", title: "Child task" };
  const grandchild = {
    ...harness.info,
    id: "grandchild",
    parentID: "child",
    title: "Nested task",
    outcome: "interrupted" as const,
  };
  const failed = {
    ...harness.info,
    id: "failed",
    parentID: "session",
    title: "Failed task",
    outcome: "failed" as const,
  };
  const lists: Parameters<V2Api["session"]["list"]>[0][] = [];
  harness.api.session.list = async (input) => {
    lists.push(input);
    if (input?.cursor) {
      if (failure === "children") throw new Error("child listing unavailable");
      return { data: [failed], cursor: {} };
    }
    if (input?.parentID === "session") {
      return { data: [child, child], cursor: { next: "next_children" } };
    }
    return { data: input?.parentID === "child" ? [grandchild] : [], cursor: {} };
  };
  harness.api.session.active = async () => {
    if (failure === "status") throw new Error("child status unavailable");
    return { child: { type: "running" } };
  };
  harness.api.message.list = async (input) => {
    if (input.cursor && input.order) throw new Error("cursor cannot be combined with order");
    if (failure === "messages" && input.sessionID === "grandchild") {
      throw new Error("grandchild messages unavailable");
    }
    if (input.sessionID === "session") return { data: [], cursor: {} };
    const result: SessionMessageInfo = {
      id: `msg_${input.sessionID}`,
      type: "user",
      text: `${input.sessionID} prompt`,
      time: { created: 1 },
    };
    if (input.cursor) {
      return {
        data: [
          {
            id: "msg_child_result",
            type: "assistant",
            content: [{ type: "text", text: "Child result" }],
            time: { created: 2 },
          },
        ],
        cursor: {},
      };
    }
    return { data: [result], cursor: input.sessionID === "child" ? { next: "next_messages" } : {} };
  };
  const forbidden = () => {
    throw new Error("Interactive operation during history read");
  };
  harness.api.permission.list = forbidden;
  harness.api.event.subscribe = forbidden;
  harness.api.session.interrupt = forbidden;
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  return {
    harness,
    lists,
    read: () =>
      client.readSessionHistory({
        provider: "opencode",
        sessionId: "session",
        metadata: { cwd: "/tmp/project" },
      }),
  };
}

describe("OpenCode v2 dedicated history", () => {
  test("reads paginated children and nested timelines without interactive setup", async () => {
    const { harness, lists, read } = createChildHistoryHarness();

    const result = await read();

    expect(result).toEqual({
      events: [
        {
          type: "provider_subagent",
          provider: "opencode",
          event: {
            type: "upsert",
            id: "child",
            parentSubagentId: null,
            title: "Child task",
            status: "running",
            cwd: "/tmp/project",
            timestamp: "1970-01-01T00:00:00.001Z",
          },
        },
        {
          type: "provider_subagent",
          provider: "opencode",
          event: {
            type: "timeline",
            id: "child",
            item: { type: "user_message", text: "child prompt", messageId: "msg_child" },
            timestamp: "1970-01-01T00:00:00.001Z",
          },
        },
        {
          type: "provider_subagent",
          provider: "opencode",
          event: {
            type: "timeline",
            id: "child",
            item: {
              type: "assistant_message",
              text: "Child result",
              messageId: "msg_child_result",
            },
            timestamp: "1970-01-01T00:00:00.002Z",
          },
        },
        {
          type: "provider_subagent",
          provider: "opencode",
          event: {
            type: "upsert",
            id: "grandchild",
            parentSubagentId: "child",
            title: "Nested task",
            status: "canceled",
            cwd: "/tmp/project",
            timestamp: "1970-01-01T00:00:00.001Z",
          },
        },
        {
          type: "provider_subagent",
          provider: "opencode",
          event: {
            type: "timeline",
            id: "grandchild",
            item: { type: "user_message", text: "grandchild prompt", messageId: "msg_grandchild" },
            timestamp: "1970-01-01T00:00:00.001Z",
          },
        },
        {
          type: "provider_subagent",
          provider: "opencode",
          event: {
            type: "upsert",
            id: "failed",
            parentSubagentId: null,
            title: "Failed task",
            status: "failed",
            cwd: "/tmp/project",
            timestamp: "1970-01-01T00:00:00.001Z",
          },
        },
        {
          type: "provider_subagent",
          provider: "opencode",
          event: {
            type: "timeline",
            id: "failed",
            item: { type: "user_message", text: "failed prompt", messageId: "msg_failed" },
            timestamp: "1970-01-01T00:00:00.001Z",
          },
        },
      ],
      coverage: { kind: "complete" },
    });
    expect(lists).toEqual([
      { parentID: "session", limit: 100 },
      { parentID: "child", limit: 100 },
      { parentID: "grandchild", limit: 100 },
      { cursor: "next_children", limit: 100 },
      { parentID: "failed", limit: 100 },
    ]);
    expect(harness.environments).toEqual([]);
    expect(harness.mcpAdds).toEqual([]);
    expect(harness.prompts).toEqual([]);
    expect(harness.creates).toEqual([]);
    expect(harness.releases).toBe(1);
  });

  test.each([
    ["children", "child listing unavailable"],
    ["messages", "grandchild messages unavailable"],
    ["status", "child status unavailable"],
  ] as const)(
    "releases the history connection when reading child %s fails",
    async (failure, message) => {
      const { harness, read } = createChildHistoryHarness(failure);

      await expect(read()).rejects.toThrow(message);
      expect(harness.releases).toBe(1);
    },
  );
});

describe("OpenCode v2 session lifecycle", () => {
  test("completes from execution events without a long-lived HTTP wait", async () => {
    const harness = new V2Harness();
    harness.prompt = async (input) => {
      harness.prompts.push(input.text);
      harness.startExecution();
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("long-running work");
      await expect.poll(() => harness.prompts).toEqual(["long-running work"]);
      expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
      expect(events.filter((event) => event.type === "turn_completed")).toEqual([]);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    } finally {
      await session.close();
    }
  });
  test.each(["reconnect", "watchdog"])(
    "recovers a missed completion through %s without reconnecting a quiet stream",
    async (recovery) => {
      const harness = new V2Harness();
      harness.autoComplete = false;
      let subscriptions = 0;
      const subscribe = harness.api.event.subscribe;
      harness.api.event.subscribe = (options) => {
        subscriptions += 1;
        return subscribe(options);
      };
      const client = new OpenCodeV2AgentClient({
        logger: createTestLogger(),
        runtime: harness.runtime,
      });
      const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
      const events: AgentStreamEvent[] = [];
      session.subscribe((event) => events.push(event));
      try {
        await session.startTurn("finish while disconnected");
        await expect.poll(() => harness.prompts).toHaveLength(1);
        // Persisted completion without its event, as after an upstream stream gap.
        harness.finishExecution("succeeded", false);
        if (recovery === "reconnect")
          harness.push({ id: "reconnect", created: 3, type: "server.connected", data: {} });
        await expect.poll(() => terminalEvents(events), { timeout: 7_000 }).toHaveLength(1);
        expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
        expect(subscriptions).toBe(1);
      } finally {
        await session.close();
      }
    },
    10_000,
  );

  test("does not finish from a previous outcome before prompt admission", async () => {
    const harness = new V2Harness();
    let accept!: () => void;
    harness.prompt = () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("fast execution");
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 3, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.startExecution();
      harness.finishExecution();
      accept();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("follows a queued successor until the session is idle", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("first and queued work");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      harness.finishExecution();
      harness.startExecution();
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 3, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  test("discards an idle snapshot overtaken by a new execution event", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    let readSnapshot!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => {
      readSnapshot = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await session.startTurn("work");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      harness.api.session.get = async () => {
        const snapshot = { ...harness.info };
        readSnapshot();
        await blocked;
        return snapshot;
      };
      harness.finishExecution();
      await reading;
      const reads = harness.activeReads;
      harness.startExecution();
      release();
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
    } finally {
      release();
      await session.close();
    }
  });

  test("does not treat shutdown interruption as a completed or canceled turn", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("resumable work");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      harness.active = false;
      // Shutdown does not project an idle outcome; the preceding run's outcome can remain.
      harness.info.outcome = "succeeded";
      harness.push({
        id: "shutdown",
        created: 3,
        type: "session.execution.interrupted",
        durable: { aggregateID: "session", seq: 3, version: 1 },
        data: { sessionID: "session", reason: "shutdown" },
      });
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 4, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.startExecution();
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("ends the turn when the user dismisses a question", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    let form: FormInfo | null = null;
    harness.api.session.form.list = async () => (form ? [form] : []);
    harness.api.session.form.cancel = async () => {
      form = null;
      harness.active = false;
      // OpenCode 2.0.20 reports a dismissed question as an interruption without a user reason.
      harness.push({
        id: "dismissed",
        created: 3,
        type: "session.execution.interrupted",
        durable: { aggregateID: "session", seq: 3, version: 1 },
        data: { sessionID: "session", reason: "shutdown" },
      });
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("ask me something");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      form = {
        id: "question",
        sessionID: "session",
        title: "Color",
        fields: [{ key: "color", type: "string", options: [{ label: "Red", value: "red" }] }],
      };
      harness.push({
        id: "form",
        created: 2,
        type: "form.created",
        data: { form },
      });
      await expect.poll(() => session.getPendingPermissions()).toHaveLength(1);

      await session.respondToPermission("question", { behavior: "deny" });

      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_canceled" });

      await session.startTurn("next message");
      await expect.poll(() => harness.prompts).toHaveLength(2);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(2);
      expect(terminalEvents(events)[1]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("ends the turn when the user denies a tool permission", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    let permission: Awaited<ReturnType<V2Api["permission"]["list"]>>[number] | null = null;
    harness.api.permission.list = async () => (permission ? [permission] : []);
    harness.api.permission.reply = async () => {
      permission = null;
      harness.active = false;
      // OpenCode 2.0.20 reports a denied tool call as an interruption without a user reason.
      harness.push({
        id: "denied",
        created: 3,
        type: "session.execution.interrupted",
        durable: { aggregateID: "session", seq: 3, version: 1 },
        data: { sessionID: "session", reason: "shutdown" },
      });
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("run printf");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      permission = {
        id: "approval",
        sessionID: "session",
        action: "shell",
        resources: ["printf TOOL_PERMISSION_QA"],
      };
      harness.push({
        id: "asked",
        created: 2,
        type: "permission.asked",
        data: permission,
      });
      await expect.poll(() => session.getPendingPermissions()).toHaveLength(1);

      await session.respondToPermission("approval", { behavior: "deny" });

      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_canceled" });

      await session.startTurn("next message");
      await expect.poll(() => harness.prompts).toHaveLength(2);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(2);
      expect(terminalEvents(events)[1]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("keeps the turn resumable after the user denies a child session's permission", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const child = { ...harness.info, id: "child", parentID: "session" };
    harness.api.session.list = async (input) => ({
      data: input?.parentID === "session" ? [child] : [],
      cursor: {},
    });
    let permission: Awaited<ReturnType<V2Api["permission"]["list"]>>[number] | null = {
      id: "child-approval",
      sessionID: "child",
      action: "shell",
      resources: ["pwd"],
    };
    harness.api.permission.list = async (input) =>
      permission && input.sessionID === "child" ? [permission] : [];
    harness.api.permission.reply = async () => {
      permission = null;
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("delegate work");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      expect(session.getPendingPermissions()).toHaveLength(1);

      await session.respondToPermission("child-approval", { behavior: "deny" });

      harness.active = false;
      harness.push({
        id: "shutdown",
        created: 3,
        type: "session.execution.interrupted",
        durable: { aggregateID: "session", seq: 3, version: 1 },
        data: { sessionID: "session", reason: "shutdown" },
      });
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 4, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.startExecution();
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("recovers the latest execution from the durable log when shutdown and resume events were missed", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("resumable work");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      harness.active = false;
      harness.info.outcome = "succeeded";
      harness.api.session.log = async function* () {
        yield {
          id: "shutdown",
          created: 3,
          type: "session.execution.interrupted",
          durable: { aggregateID: "session", seq: 3, version: 1 },
          data: { sessionID: "session", reason: "shutdown" },
        };
      };
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 4, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.api.session.log = async function* () {
        yield {
          id: "done",
          created: 6,
          type: "session.execution.succeeded",
          durable: { aggregateID: "session", seq: 6, version: 1 },
          data: { sessionID: "session" },
        };
      };
      harness.push({
        id: "reconnect-after-resume",
        created: 7,
        type: "server.connected",
        data: {},
      });
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("keeps the turn alive through an observation transport failure", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const active = harness.api.session.active;
    let attempted = false;
    harness.api.session.active = async () => {
      attempted = true;
      throw new Error("fetch failed");
    };
    try {
      await session.startTurn("work");
      await expect.poll(() => attempted).toBe(true);
      expect(terminalEvents(events)).toEqual([]);
      harness.api.session.active = active;
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test.each([
    { variants: ["medium", "custom"], selected: "medium", expected: "medium" },
    { variants: ["custom"], selected: "custom", expected: "custom" },
    { variants: ["high"], selected: "medium", expected: undefined },
    { variants: [], selected: "medium", expected: undefined },
    { variants: ["medium"], selected: "default", expected: undefined },
  ])(
    "model switches retain only supported variants: $selected / $variants",
    async ({ variants, selected, expected }) => {
      const harness = new V2Harness();
      const target: ModelInfo = {
        id: "target",
        modelID: "target",
        providerID: "test",
        name: "Target",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: variants.map((id) => ({ id })),
        time: { released: 1 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 200000, output: 10000 },
      };
      harness.info.model = { providerID: "test", id: "source", variant: selected };
      harness.api.model.list = async () => ({ location: harness.info.location, data: [target] });
      harness.api.session.switchModel = async ({ model }) => {
        harness.info.model = model;
      };
      const client = new OpenCodeV2AgentClient({
        logger: createTestLogger(),
        runtime: harness.runtime,
      });
      const session = await client.createSession({
        provider: "opencode",
        cwd: "/tmp/project",
        model: "test/source",
        thinkingOptionId: selected,
      });
      const events: AgentStreamEvent[] = [];
      session.subscribe((event) => events.push(event));
      try {
        await session.setModel!("test/target");
        expect(await session.getRuntimeInfo()).toMatchObject({
          model: "test/target",
          thinkingOptionId: expected ?? null,
        });
        expect(session.describePersistence().metadata?.thinkingOptionId).toBe(expected);
        expect(events).toContainEqual({
          type: "thinking_option_changed",
          provider: "opencode",
          thinkingOptionId: expected ?? null,
        });
        await expect(session.setModel!("test/missing")).rejects.toThrow(
          "OpenCode model unavailable",
        );
        harness.api.session.switchModel = async () => {
          throw new Error("Switch failed");
        };
        await expect(session.setModel!("test/target")).rejects.toThrow("Switch failed");
        expect(session.describePersistence().metadata?.thinkingOptionId).toBe(expected);
        expect(harness.info.model).toEqual({
          providerID: "test",
          id: "target",
          ...(expected ? { variant: expected } : {}),
        });
        harness.api.session.switchModel = async ({ model }) => {
          harness.info.model = model;
        };
        harness.api.model.default = async () => ({ location: harness.info.location, data: target });
        await session.setThinkingOption!("unsupported");
        await session.setModel!(null);
        expect((await session.getRuntimeInfo()).thinkingOptionId).toBeNull();
        harness.api.model.list = async () => {
          throw new Error("Catalog unavailable");
        };
        await expect(session.setModel!("test/source")).rejects.toThrow("Catalog unavailable");
        expect((await session.getRuntimeInfo()).model).toBe("test/target");
      } finally {
        await session.close();
      }
    },
  );

  test("restores each same-directory agent environment on reconnect and resume", async () => {
    const first = new V2Harness();
    const second = new V2Harness();
    first.info.id = "session-first";
    second.info.id = "session-second";
    const environments = new Map<string, Record<string, string>>();
    const bind = async (input: { sessionID: string; variables: Record<string, string> }) => {
      environments.set(input.sessionID, { ...input.variables });
    };
    first.api.session.environment = bind;
    second.api.session.environment = bind;
    const clients = [first, second].map(
      (harness) =>
        new OpenCodeV2AgentClient({
          logger: createTestLogger(),
          runtime: harness.runtime,
          settings: {
            env: {
              PASEO_ENV_TEST: "configured",
              PASEO_AGENT_ID: "configured",
              ELECTRON_RUN_AS_NODE: "1",
              PASEO_SUPERVISED: "1",
              CLAUDECODE: "1",
            },
          },
        }),
    );
    const config = { provider: "opencode" as const, cwd: "/tmp/project" };
    const launches = ["first", "second"].map((id) => ({
      env: { PASEO_AGENT_ID: id, PASEO_AGENT_CWD: config.cwd },
    }));
    const assertEnvironment = (index: number) => {
      const env = environments.get([first, second][index].info.id);
      expect(env?.PATH).toBe(process.env.PATH);
      expect(env).toMatchObject({ ...launches[index].env, PASEO_ENV_TEST: "configured" });
      expect(env?.USER).toBe(process.env.USER);
      for (const key of [
        "ELECTRON_RUN_AS_NODE",
        "PASEO_SUPERVISED",
        "CLAUDECODE",
        "ESBUILD_BINARY_PATH",
        "PASEO_NODE_ENV",
      ]) {
        expect(env).not.toHaveProperty(key);
      }
    };
    const sessions = await Promise.all(
      clients.map((client, i) => client.createSession(config, launches[i])),
    );
    try {
      assertEnvironment(0);
      assertEnvironment(1);
      environments.clear();
      first.push({ id: "reconnected-first", created: 2, type: "server.connected", data: {} });
      second.push({ id: "reconnected-second", created: 2, type: "server.connected", data: {} });
      await expect.poll(() => environments.size).toBe(2);
      assertEnvironment(0);
      assertEnvironment(1);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
    }
    environments.clear();
    const resumed = await Promise.all(
      clients.map((client, i) =>
        client.resumeSession(sessions[i].describePersistence(), undefined, launches[i]),
      ),
    );
    try {
      assertEnvironment(0);
      assertEnvironment(1);
      expect(first.prompts).toEqual([]);
      expect(second.prompts).toEqual([]);
    } finally {
      await Promise.all(resumed.map((session) => session.close()));
    }
  });

  test("reconnects after a helper exits and restores session configuration on the next turn", async () => {
    const first = new V2Harness();
    const second = new V2Harness(1);
    let exit!: (error: Error) => void;
    const exited = new Promise<Error>((resolve) => {
      exit = resolve;
    });
    let acquisitions = 0;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: {
        acquire: async () => {
          acquisitions += 1;
          return acquisitions === 1 ? { ...first.connection, exited } : second.connection;
        },
        shutdown: async () => undefined,
      },
    });
    first.autoComplete = false;
    second.prompt = async (input) => {
      second.history.push({
        id: "answer",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 2 },
        content: [{ type: "text", text: "recovered" }],
      });
      second.prompts.push(input.text);
    };
    const session = await client.createSession(
      {
        provider: "opencode",
        cwd: "/tmp/project",
        mcpServers: { tools: { type: "stdio", command: "tools" } },
      },
      { env: { TOKEN: "test" } },
    );
    const running = session.run("before exit");
    await expect.poll(() => first.prompts).toEqual(["before exit"]);
    exit(new Error("helper exited"));
    await expect(running).rejects.toThrow("helper exited");
    expect(acquisitions).toBe(1);
    try {
      expect((await session.run("after exit")).finalText).toBe("recovered");
      expect(second.prompts).toEqual(["after exit"]);
      expect(second.mcpAdds).toEqual(["tools"]);
      expect(second.environments).toMatchObject([
        { sessionID: "session", variables: { TOKEN: "test", PATH: process.env.PATH } },
      ]);
      expect(second.environments).toEqual(first.environments);
      expect(first.releases).toBe(1);
    } finally {
      await session.close();
    }
    await expect(session.startTurn("after close")).rejects.toThrow("OpenCode session is closed");
  });
  test("fails initialization when the event stream ends before connecting", async () => {
    const harness = new V2Harness();
    harness.api.event.subscribe = async function* () {};
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    await expect(
      client.createSession({ provider: "opencode", cwd: "/tmp/project" }),
    ).rejects.toThrow("event stream ended before connecting");
    expect(harness.releases).toBeGreaterThan(0);
  });

  test("returns only validated structured output and preserves it in history", async () => {
    const harness = new V2Harness();
    harness.prompt = async (input) => {
      harness.history.push({
        id: "user",
        type: "user",
        text: input.text,
        metadata: input.metadata,
        time: { created: 1 },
      });
      harness.history.push({
        id: "answer",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 2 },
        content: [
          { type: "text", text: "Here is the answer" },
          {
            type: "tool",
            id: "output",
            name: "paseo_structured_output",
            time: { created: 2 },
            state: {
              status: "completed",
              input: { value: { answer: 42 } },
              content: [{ type: "text", text: "accepted" }],
              metadata: { paseoStructuredOutput: { answer: 42 } },
            },
          },
        ],
      });
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      const result = await session.run("answer", {
        outputSchema: {
          type: "object",
          properties: { answer: { const: 42 } },
          required: ["answer"],
        },
      });
      expect(result.finalText).toBe('{"answer":42}');
      const history = [];
      for await (const event of session.streamHistory!()) history.push(event);
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "timeline",
            item: expect.objectContaining({ type: "assistant_message", text: result.finalText }),
          }),
        ]),
      );
    } finally {
      await session.close();
    }
  });

  test("fails a structured turn when the model omits the validated output tool", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await expect(session.run("answer", { outputSchema: { type: "object" } })).rejects.toThrow(
        "without submitting the required structured output",
      );
    } finally {
      await session.close();
    }
  });

  test("resumes the native session ID and never replaces a missing session", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const handle = {
      provider: "opencode",
      sessionId: "session",
      nativeHandle: "session",
      metadata: { cwd: "/tmp/project" },
    } as const;
    harness.api.session.switchAgent = async ({ agent }) => {
      harness.info.agent = agent;
    };
    harness.api.session.switchModel = async ({ model }) => {
      harness.info.model = model;
    };
    const session = await client.resumeSession(handle, {
      modeId: "plan",
      model: "synthetic/test",
      thinkingOptionId: "low",
    });
    try {
      expect(await session.getRuntimeInfo!()).toMatchObject({
        modeId: "plan",
        model: "synthetic/test",
        thinkingOptionId: "low",
      });
      expect(await session.describePersistence()).toMatchObject({
        sessionId: "session",
        nativeHandle: "session",
      });
      expect(harness.creates).toEqual([]);
    } finally {
      await session.close();
    }
    harness.api.session.get = async () => {
      throw new Error("Session not found");
    };
    await expect(client.resumeSession(handle)).rejects.toThrow("Session not found");
    expect(harness.creates).toEqual([]);
  });

  test("reconciles reconnect snapshots without replaying text or losing repeated chunks", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const finish = () => harness.finishExecution();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const chunks: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "assistant_message")
        chunks.push(event.item.text);
    });
    try {
      const running = session.run("laugh");
      await expect.poll(() => harness.prompts).toEqual(["laugh"]);
      const answer = {
        id: "answer",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 2 },
        content: [{ type: "text", text: "ha" }],
      } satisfies SessionMessageInfo;
      harness.history.push(answer);
      harness.push({ id: "reconnect-1", created: 2, type: "server.connected", data: {} });
      await expect.poll(() => chunks).toEqual(["ha"]);
      answer.content[0].text = "haha";
      harness.push({ id: "reconnect-2", created: 3, type: "server.connected", data: {} });
      await expect.poll(() => chunks).toEqual(["ha", "ha"]);
      finish();
      expect((await running).finalText).toBe("haha");
      expect(chunks).toEqual(["ha", "ha"]);
    } finally {
      await session.close();
    }
  });

  test("retries observation failures without replacing the execution error", async () => {
    const harness = new V2Harness();
    harness.info.outcome = "failed";
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      let attempted = false;
      harness.api.session.log = () => {
        attempted = true;
        throw new Error("log unavailable");
      };
      await session.startTurn("hello");
      const failures = () => events.filter((event) => event.type === "turn_failed");
      await expect.poll(() => attempted).toBe(true);
      expect(failures()).toEqual([]);
      harness.api.session.log = async function* () {
        yield {
          id: "failure",
          created: 2,
          durable: { aggregateID: "session", seq: 2, version: 1 },
          type: "session.execution.failed",
          data: { sessionID: "session", error: { type: "provider", message: "quota exhausted" } },
        };
      };
      harness.push({ id: "reconnect", created: 3, type: "server.connected", data: {} });
      await expect.poll(failures).toHaveLength(1);
      expect(failures()[0]).toMatchObject({ error: "quota exhausted" });
      expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  test("waits for prompt acceptance before interrupting", async () => {
    const harness = new V2Harness();
    let accept!: () => void;
    const settle = () => harness.finishExecution("interrupted");
    let interruptions = 0;
    harness.prompt = () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      });

    harness.interrupt = async () => {
      interruptions += 1;
      harness.info.outcome = "interrupted";
      settle();
      return { interrupted: true };
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.startTurn("first");
      const stopping = session.interrupt();
      await Promise.resolve();
      expect(interruptions).toBe(0);
      accept();
      await stopping;
      expect(interruptions).toBe(1);
    } finally {
      await session.close();
    }
  });

  test("completes a submitted turn once and reconciles its final text", async () => {
    const harness = new V2Harness();
    harness.prompt = async (input) => {
      harness.prompts.push(input.text);
      harness.history.push({
        id: "answer",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 2 },
        content: [{ type: "text", text: "done" }],
      });
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      const result = await session.run("hello");
      expect(result.finalText).toBe("done");
      expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
      expect(harness.creates[0]).toMatchObject({
        agent: "build",
        location: { directory: "/tmp/project" },
      });
    } finally {
      await session.close();
    }
    expect(harness.releases).toBe(1);
  });

  test("waits for interruption settlement before submitting replacement work", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const finishFirst = () => harness.finishExecution("interrupted");
    let finishStop!: () => void;
    harness.interrupt = () =>
      new Promise((resolve) => {
        finishStop = () => {
          harness.info.outcome = "interrupted";
          finishFirst();
          resolve({ interrupted: true });
        };
      });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.startTurn("first");
      await expect.poll(() => harness.prompts).toEqual(["first"]);
      const stopping = session.interrupt();
      const replacement = session.startTurn("second");
      await Promise.resolve();
      expect(harness.prompts).toEqual(["first"]);
      harness.autoComplete = true;
      finishStop();
      await stopping;
      await replacement;
      await expect.poll(() => harness.prompts).toEqual(["first", "second"]);
    } finally {
      await session.close();
    }
  });

  test("reuses the shared helper for sessions whose env is only agent identity", async () => {
    const harness = new V2Harness();
    const acquires: Array<{ env?: Record<string, string>; dedicated?: boolean }> = [];
    const runtime = {
      acquire: async (input: { env?: Record<string, string>; dedicated?: boolean } = {}) => {
        acquires.push(input);
        return harness.connection;
      },
      shutdown: async () => undefined,
    };
    const client = new OpenCodeV2AgentClient({ logger: createTestLogger(), runtime });
    const session = await client.createSession(
      { provider: "opencode", cwd: "/tmp/project" },
      { agentId: "agent", env: { PASEO_AGENT_ID: "agent", PASEO_AGENT_CWD: "/tmp/project" } },
    );
    try {
      expect(acquires).toEqual([{}]);
      expect(harness.environments).toMatchObject([
        {
          sessionID: "session",
          variables: { PASEO_AGENT_ID: "agent", PASEO_AGENT_CWD: "/tmp/project" },
        },
      ]);
    } finally {
      await session.close();
    }
  });

  test("starts a dedicated helper when the session carries custom MCP", async () => {
    const harness = new V2Harness();
    const acquires: Array<{ env?: Record<string, string>; dedicated?: boolean }> = [];
    const runtime = {
      acquire: async (input: { env?: Record<string, string>; dedicated?: boolean } = {}) => {
        acquires.push(input);
        return harness.connection;
      },
      shutdown: async () => undefined,
    };
    const client = new OpenCodeV2AgentClient({ logger: createTestLogger(), runtime });
    const session = await client.createSession(
      {
        provider: "opencode",
        cwd: "/tmp/project",
        mcpServers: { custom: { type: "stdio", command: "custom", args: [] } },
      },
      { agentId: "agent", env: { PASEO_AGENT_ID: "agent", PASEO_AGENT_CWD: "/tmp/project" } },
    );
    try {
      expect(acquires).toHaveLength(1);
      expect(acquires[0]?.dedicated).toBe(true);
    } finally {
      await session.close();
    }
  });

  test("refuses replacement work after a failed stop until Stop succeeds", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const finishFirst = () => harness.finishExecution("interrupted");
    harness.interrupt = async () => {
      throw new Error("stop failed");
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.startTurn("first");
      await expect.poll(() => harness.prompts).toEqual(["first"]);
      await expect(session.interrupt()).rejects.toThrow("stop failed");
      await expect(session.startTurn("unsafe replacement")).rejects.toThrow("stop failed");
      expect(harness.prompts).toEqual(["first"]);
      harness.interrupt = async () => {
        finishFirst();
        return { interrupted: true };
      };
      await session.interrupt();
      harness.autoComplete = true;
      await session.startTurn("retry");
      await expect.poll(() => harness.prompts).toEqual(["first", "retry"]);
    } finally {
      await session.close();
    }
  });
});
