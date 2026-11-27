import { once } from "node:events";
import { createServer } from "node:http";
import type { FormInfo, ModelInfo, SessionInfo, SessionMessageInfo } from "@opencode/client";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import { ProviderSubagentStore } from "../../../provider-subagents/store.js";
import type { V2RuntimeAcquireOptions } from "./runtime.js";
import { OpenCodeV2AgentClient } from "./agent.js";
import { OpenCodeV2Session } from "./session.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import type { V2Api } from "./api.js";
import { V2Runtime } from "./runtime.js";

function terminalEvents(events: AgentStreamEvent[]) {
  return events.filter(
    (event) =>
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled",
  );
}

function toolCallEvents(events: AgentStreamEvent[], callId: string) {
  return events.filter(
    (event) =>
      event.type === "timeline" && event.item.type === "tool_call" && event.item.callId === callId,
  );
}

describe("OpenCode v2 session lifecycle", () => {
  test("reopening replaces and removes plugin instructions", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const created = await client.createSession({
      provider: "opencode",
      cwd: "/tmp/project",
      pluginAppendSystemPrompt: ["first"],
    });
    expect(harness.instructions.get("paseo")).toBe("first");
    const handle = created.describePersistence()!;
    await created.close();
    const resumed = await client.resumeSession(handle, {
      cwd: "/tmp/project",
      pluginAppendSystemPrompt: ["changed"],
    });
    expect(harness.instructions.get("paseo")).toBe("changed");
    await resumed.close();
    const cleared = await client.resumeSession(handle, {
      cwd: "/tmp/project",
      pluginAppendSystemPrompt: undefined,
    });
    expect(harness.instructions.has("paseo")).toBe(false);
    await cleared.close();
  });

  test("opening history does not change an existing session instruction", async () => {
    const harness = new V2Harness();
    harness.instructions.set("paseo", "Existing plugin instruction");
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.resumeSession(
      { provider: "opencode", sessionId: "session", metadata: { cwd: "/tmp/project" } },
      { cwd: "/tmp/project" },
      undefined,
      { purpose: "history" },
    );
    try {
      expect(harness.instructions.get("paseo")).toBe("Existing plugin instruction");
    } finally {
      await session.close();
    }
  });

  test("refreshes the existing location before reading a forced catalog", async () => {
    const harness = new V2Harness();
    const refreshed: string[] = [];
    harness.connection.refreshLocation = async (directory) => {
      refreshed.push(directory);
    };
    harness.api.model.list = async () => ({ location: harness.info.location, data: [] });
    harness.api.provider.list = async () => ({
      location: harness.info.location,
      data: [{ id: "test", name: "Test", activation: "enabled", package: "test" }],
    });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    await client.fetchCatalog({ scope: "workspace", cwd: "/tmp/project", force: true });
    await client.fetchCatalog({ scope: "workspace", cwd: "/tmp/project", force: false });
    expect(refreshed).toEqual(["/tmp/project"]);
    await client.shutdown();
  });
  test("rejects a live auto_accept the creation schema would reject", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });

    await expect(session.applyOptions?.({ auto_accept: "yes" })).rejects.toThrow(/auto_accept/);
    await expect(session.applyOptions?.({ auto_accept: true })).resolves.toBeUndefined();
    await session.close();
  });

  test("a rejected auto_accept leaves the running session asking for permission", async () => {
    const harness = new V2Harness();
    const permissions = [
      { id: "approval", sessionID: "session", action: "shell", resources: ["pwd"] },
    ];
    harness.api.permission.list = async () => permissions;
    const replies: string[] = [];
    harness.api.permission.reply = async (input) => {
      replies.push(input.requestID);
      throw new Error("upstream refused");
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await expect(session.applyOptions?.({ auto_accept: true })).rejects.toThrow(
        "upstream refused",
      );

      const next = {
        id: "next",
        sessionID: "session",
        action: "shell",
        resources: ["ls"],
      };
      permissions.push(next);
      harness.push({ id: "asked", created: 2, type: "permission.asked", data: next });

      const pendingIds = () => session.getPendingPermissions().map(({ id }) => id);
      await expect.poll(pendingIds).toContain("next");
      expect(replies).not.toContain("next");
    } finally {
      await session.close();
    }
  });

  test("rejects a live permission change the running session cannot apply", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({
      provider: "opencode",
      cwd: "/tmp/project",
      providerOptions: { permission: "allow" },
    });

    await expect(session.applyOptions?.({ permission: "deny" })).rejects.toThrow(
      /permission.*cannot change on a running session/,
    );
    await expect(
      session.applyOptions?.({ permission: "allow", auto_accept: true }),
    ).resolves.toBeUndefined();
    await session.close();
  });

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

  test("recovers a resumed execution from persisted session info when shutdown and resume events were missed", async () => {
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
      // Shutdown clears /api/session/active without advancing time.idle; a prior outcome can remain.
      harness.active = false;
      harness.info.outcome = "succeeded";
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 4, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      // OpenCode resumes and finishes while SSE misses both events (and session.log has only log.synced).
      harness.startExecution(false);
      harness.finishExecution("succeeded", false);
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

  test.each(["with", "without"])(
    "removes a tracked child deleted during disconnect %s a launch environment",
    async (launchEnvironment) => {
      const harness = new V2Harness();
      const child: SessionInfo = { ...harness.info, id: "deleted", parentID: "session" };
      const sibling: SessionInfo = { ...harness.info, id: "sibling", parentID: "session" };
      const grandchild: SessionInfo = { ...harness.info, id: "grandchild", parentID: sibling.id };
      const sessions = new Map([[harness.info.id, harness.info]]);
      harness.api.session.list = async ({ parentID } = {}) => ({
        data: parentID ? [...sessions.values()].filter((info) => info.parentID === parentID) : [],
        cursor: {},
      });
      harness.api.session.active = async () =>
        sessions.has(child.id) ? { [child.id]: { type: "running" } } : {};

      const server = createServer(async (request, response) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        if (pathname === "/api/info") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ version: "2.3.0", pid: 1, urls: [], paths: { tmp: "/tmp" } }),
          );
          return;
        }
        const sessionPath = /^\/api\/session\/([^/]+)(\/environment)?$/.exec(pathname);
        if (!sessionPath) {
          response.writeHead(404).end();
          return;
        }
        const [, sessionID, environmentPath] = sessionPath;
        const info = sessions.get(sessionID);
        if (!info) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              _tag: "SessionNotFoundError",
              sessionID,
              message: "Session not found",
            }),
          );
          return;
        }
        if (environmentPath && request.method === "PUT") {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk);
          const { variables } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          harness.environments.push({ sessionID, variables });
          response.writeHead(204).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: info }));
      }).listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server port");
      const logger = createTestLogger();
      const runtime = new V2Runtime({
        logger,
        selection: { kind: "explicit", server: { url: `http://127.0.0.1:${address.port}` } },
      });

      try {
        // Keep control of the event stream and turn completion while sending session lookups
        // and environment requests through the same HTTP transport as a real server.
        const connection = await runtime.acquire();
        harness.api.session.get = connection.client.session.get;
        harness.api.session.environment = connection.client.session.environment;
        const client = new OpenCodeV2AgentClient({ logger, runtime: harness.runtime });
        const session = await client.createSession(
          { provider: "opencode", cwd: "/tmp/project" },
          launchEnvironment === "with" ? { env: { PASEO_AGENT_ID: "parent" } } : undefined,
        );
        const store = new ProviderSubagentStore();
        session.subscribe((event) => {
          if (event.type === "provider_subagent") store.apply("parent", "opencode", event.event);
        });
        try {
          for (const info of [child, sibling, grandchild]) sessions.set(info.id, info);
          harness.push({ id: child.id, created: 2, type: "session.created", data: child });
          const ids = () =>
            store
              .list("parent")
              .map(({ id }) => id)
              .sort();
          await expect.poll(ids).toEqual([child.id, grandchild.id, sibling.id]);
          expect(store.list("parent").find(({ id }) => id === child.id)?.status).toBe("running");

          sessions.delete(child.id);
          harness.environments.length = 0;
          harness.push({ id: "reconnected", created: 3, type: "server.connected", data: {} });

          await expect.poll(ids).toEqual([grandchild.id, sibling.id]);
          if (launchEnvironment === "with") {
            await expect
              .poll(() => harness.environments)
              .toMatchObject([
                { sessionID: harness.info.id, variables: { PASEO_AGENT_ID: "parent" } },
                { sessionID: sibling.id, variables: { PASEO_AGENT_ID: "parent" } },
                { sessionID: grandchild.id, variables: { PASEO_AGENT_ID: "parent" } },
              ]);
          }
          await expect(session.run("continue after reconnect")).resolves.toMatchObject({
            sessionId: harness.info.id,
          });
        } finally {
          await session.close();
        }
      } finally {
        await runtime.shutdown();
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
      }
    },
  );

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
      { provider: "opencode", cwd: "/tmp/project" },
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
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("hello");
      await expect.poll(() => harness.prompts).toEqual(["hello"]);
      let attempted = false;
      const originalList = harness.api.message.list;
      harness.api.message.list = async () => {
        attempted = true;
        throw new Error("messages unavailable");
      };
      harness.finishExecution("failed", false, { message: "quota exhausted" });
      harness.push({ id: "reconnect-1", created: 2, type: "server.connected", data: {} });
      const failures = () => events.filter((event) => event.type === "turn_failed");
      await expect.poll(() => attempted).toBe(true);
      expect(failures()).toEqual([]);
      harness.api.message.list = originalList;
      harness.push({ id: "reconnect-2", created: 3, type: "server.connected", data: {} });
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

  test("shares the server for a launch environment, which reaches the session only", async () => {
    const harness = new V2Harness();
    let acquisitions = 0;
    const runtime = {
      acquire: async () => {
        acquisitions += 1;
        return harness.connection;
      },
      shutdown: async () => undefined,
    };
    const client = new OpenCodeV2AgentClient({ logger: createTestLogger(), runtime });
    const session = await client.createSession(
      { provider: "opencode", cwd: "/tmp/project" },
      { agentId: "agent", env: { HUB_SECRET: "secret", PASEO_AGENT_ID: "agent" } },
    );
    try {
      expect(acquisitions).toBe(1);
      expect(harness.environments).toMatchObject([
        { sessionID: "session", variables: { HUB_SECRET: "secret", PASEO_AGENT_ID: "agent" } },
      ]);
    } finally {
      await session.close();
    }
  });

  test("asks the runtime for a server behind the wrap and the launch environment when creating and resuming", async () => {
    const servers = [new V2Harness(), new V2Harness()];
    const requests: unknown[] = [];
    const runtime = {
      acquire: async (input?: V2RuntimeAcquireOptions) => {
        requests.push(input?.dedicated);
        const server = servers[requests.length - 1];
        if (!server) throw new Error("No OpenCode test server left");
        return server.connection;
      },
      shutdown: async () => undefined,
    };
    const client = new OpenCodeV2AgentClient({ logger: createTestLogger(), runtime });
    const wrap = ["/opt/sandbox/bin/run", "--profile", "a b"] as const;
    const env = { SANDBOX_PROFILE: "agent" };
    const created = await client.createSession(
      { provider: "opencode", cwd: "/tmp/project" },
      { agentId: "agent", wrap, env },
    );
    try {
      // The created session's connection is live, and a wrapped resume still asks for its own.
      const resumed = await client.resumeSession(
        {
          provider: "opencode",
          sessionId: "session",
          nativeHandle: "session",
          metadata: { cwd: "/tmp/project" },
        },
        undefined,
        { agentId: "agent", wrap, env },
        { purpose: "history" },
      );
      await resumed.close();
      expect(requests).toEqual([
        { wrap, env },
        { wrap, env },
      ]);
    } finally {
      await created.close();
    }
  });

  test("imports a wrapped session through one wrapped server, from the first session lookup", async () => {
    const server = new V2Harness();
    // Import restores the session's agent.
    server.api.session.switchAgent = async () => undefined;
    const requests: unknown[] = [];
    const runtime = {
      acquire: async (input?: V2RuntimeAcquireOptions) => {
        requests.push(input?.dedicated);
        return server.connection;
      },
      shutdown: async () => undefined,
    };
    const client = new OpenCodeV2AgentClient({ logger: createTestLogger(), runtime });
    const wrap = ["/opt/sandbox/bin/run", "--profile", "import"] as const;
    const env = { SANDBOX_PROFILE: "import" };
    const config = { provider: "opencode", cwd: "/tmp/project" } as const;
    const imported = await client.importSession(
      { providerHandleId: "session", cwd: "/tmp/project" },
      { config, storedConfig: config, launchContext: { agentId: "agent", wrap, env } },
    );
    await imported.session.close();
    expect(requests).toEqual([{ wrap, env }]);
  });

  test("rejects MCP servers without the Paseo bridge before creating an OpenCode session", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    await expect(
      client.createSession({
        provider: "opencode",
        cwd: "/tmp/project",
        mcpServers: { custom: { type: "stdio", command: "custom", args: [] } },
      }),
    ).rejects.toThrow("OpenCode MCP servers require the Paseo tool bridge");
    expect(harness.creates).toEqual([]);
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

  test("settles missed interrupted and failed SSE events from persisted session info", async () => {
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
      // 1. Missed interrupted SSE event settles cleanly and unblocks follow-up work.
      await session.startTurn("cancel without sse");
      await expect.poll(() => harness.prompts).toEqual(["cancel without sse"]);
      harness.finishExecution("interrupted", false);
      harness.push({ id: "reconnect-1", created: 10, type: "server.connected", data: {} });
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_canceled" });

      // 2. Missed failed SSE event reads idle.error.message (OpenCode 2.1+).
      await session.startTurn("fail with idle error");
      await expect.poll(() => harness.prompts).toHaveLength(2);
      harness.finishExecution("failed", false, { message: "provider rejected request" });
      harness.push({ id: "reconnect-2", created: 20, type: "server.connected", data: {} });
      await expect.poll(() => terminalEvents(events)).toHaveLength(2);
      expect(terminalEvents(events)[1]).toMatchObject({
        type: "turn_failed",
        error: "provider rejected request",
      });

      // 3. OpenCode 2.0.10-2.0.x without idle.error falls back to latest assistant.error.message.
      await session.startTurn("fail with assistant error");
      await expect.poll(() => harness.prompts).toHaveLength(3);
      harness.history.push({
        id: "assistant-err",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 30, completed: 31 },
        content: [],
        error: { type: "provider", message: "assistant step failed" } as never,
      });
      harness.finishExecution("failed", false);
      harness.push({ id: "reconnect-3", created: 35, type: "server.connected", data: {} });
      await expect.poll(() => terminalEvents(events)).toHaveLength(3);
      expect(terminalEvents(events)[2]).toMatchObject({
        type: "turn_failed",
        error: "assistant step failed",
      });
    } finally {
      await session.close();
    }
  });

  test("settles missed completions on OpenCode 2.0.10-2.2.1 without time.busy", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    // Simulate an out-of-band turn completed while Paseo was idle (no time.busy on 2.0.10-2.2.1).
    harness.info.time.idle = 50;
    delete harness.info.time.busy;
    harness.info.outcome = "succeeded";
    const originalGet = harness.api.session.get;
    harness.api.session.get = async (input, options) => {
      const info = await originalGet(input, options);
      delete (info.time as { busy?: number }).busy;
      return info;
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      // Simulate another client finishing a turn while Paseo is idle.
      harness.info.time.idle = 100;
      await session.startTurn("legacy server work");
      await expect.poll(() => harness.prompts).toEqual(["legacy server work"]);
      // Shutdown pauses execution without advancing time.idle past baseline 100.
      harness.active = false;
      const reads = harness.activeReads;
      harness.push({ id: "reconnect-1", created: 105, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      // Resumed turn finishes and advances time.idle past 100.
      harness.finishExecution("succeeded", false);
      delete harness.info.time.busy;
      harness.push({ id: "reconnect-2", created: 110, type: "server.connected", data: {} });
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("updates a running tool call under the canceled turn before turn_canceled on Stop and replacement send", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const runningTool = {
      type: "tool" as const,
      id: "call-bash-1",
      name: "bash",
      state: {
        status: "running" as const,
        input: { command: "sleep 60" },
        metadata: {},
      },
      time: { created: 10, ran: 10 },
    };
    const assistantMessage: SessionMessageInfo = {
      id: "a-tool-1",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "model" },
      time: { created: 10 },
      content: [runningTool],
    };
    harness.interrupt = async () => {
      assistantMessage.time.completed = 20;
      assistantMessage.content = [
        {
          type: "tool",
          id: "call-bash-1",
          name: "bash",
          state: {
            status: "error",
            input: { command: "sleep 60" },
            error: "Interrupted",
            metadata: {},
          },
          time: { created: 10, ran: 10, completed: 20 },
        },
      ];
      harness.finishExecution("interrupted");
      return { interrupted: true };
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      const { turnId: firstTurnId } = await session.startTurn("run a long command");
      await expect.poll(() => harness.prompts).toEqual(["run a long command"]);
      harness.history.push(assistantMessage);
      harness.push({
        id: "tool-running",
        created: 11,
        type: "session.tool.updated",
        data: { sessionID: harness.info.id, assistantMessageID: assistantMessage.id },
      } as never);
      await expect.poll(() => toolCallEvents(events, "call-bash-1")).toHaveLength(1);

      await session.interrupt();

      // The final tool_call update must carry T1 and arrive before turn_canceled.
      const relevant = events.filter(
        (event) =>
          event.type === "turn_canceled" ||
          (event.type === "timeline" &&
            event.item.type === "tool_call" &&
            event.item.callId === "call-bash-1"),
      );
      expect(relevant).toEqual([
        expect.objectContaining({
          type: "timeline",
          turnId: firstTurnId,
          item: expect.objectContaining({
            type: "tool_call",
            callId: "call-bash-1",
            status: "running",
          }),
        }),
        expect.objectContaining({
          type: "timeline",
          turnId: firstTurnId,
          item: expect.objectContaining({
            type: "tool_call",
            callId: "call-bash-1",
            status: "failed",
          }),
        }),
        expect.objectContaining({ type: "turn_canceled", turnId: firstTurnId }),
      ]);

      // An immediate replacement turn must never receive late items from the canceled turn.
      harness.autoComplete = true;
      const { turnId: secondTurnId } = await session.startTurn("next work");
      await expect.poll(() => terminalEvents(events)).toHaveLength(2);
      const lateToolEvents = events.filter(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.callId === "call-bash-1" &&
          event.turnId !== firstTurnId,
      );
      expect(lateToolEvents).toEqual([]);
      expect(terminalEvents(events)[1]).toMatchObject({
        type: "turn_completed",
        turnId: secondTurnId,
      });
    } finally {
      await session.close();
    }
  });

  test("settles interrupt promptly when reconcileSnapshot is slow and still tags late tool updates with the canceled turn id", async () => {
    vi.useFakeTimers();
    const harness = new V2Harness();
    harness.autoComplete = false;
    const assistantMessage: SessionMessageInfo = {
      id: "a-slow-tool",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "model" },
      time: { created: 10 },
      content: [
        {
          type: "tool",
          id: "call-slow-1",
          name: "bash",
          state: { status: "running", input: { command: "sleep 60" }, metadata: {} },
          time: { created: 10, ran: 10 },
        },
      ],
    };
    harness.interrupt = async () => {
      assistantMessage.time.completed = 20;
      assistantMessage.content = [
        {
          type: "tool",
          id: "call-slow-1",
          name: "bash",
          state: {
            status: "error",
            input: { command: "sleep 60" },
            error: "Interrupted",
            metadata: {},
          },
          time: { created: 10, ran: 10, completed: 20 },
        },
      ];
      harness.finishExecution("interrupted");
      return { interrupted: true };
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    let listReleased = false;
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = () => {
        listReleased = true;
        resolve();
      };
    });
    const originalList = harness.api.message.list;
    try {
      const { turnId: firstTurnId } = await session.startTurn("large session work");
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.prompts).toEqual(["large session work"]);
      harness.history.push(assistantMessage);
      harness.push({
        id: "slow-tool-running",
        created: 11,
        type: "session.tool.updated",
        data: { sessionID: harness.info.id, assistantMessageID: assistantMessage.id },
      } as never);
      await vi.advanceTimersByTimeAsync(30);
      expect(
        events.some(
          (event) =>
            event.type === "timeline" &&
            event.item.type === "tool_call" &&
            event.item.callId === "call-slow-1" &&
            event.turnId === firstTurnId,
        ),
      ).toBe(true);

      // Block message.list to simulate a slow reconcileSnapshot (>250ms budget).
      harness.api.message.list = async (input, options) => {
        await listGate;
        return originalList(input, options);
      };
      let stopped = false;
      const stop = (async () => {
        await session.interrupt();
        stopped = true;
      })();
      await vi.advanceTimersByTimeAsync(260);
      await stop;
      expect(stopped).toBe(true);
      expect(listReleased).toBe(false);
      expect(terminalEvents(events)).toEqual([
        expect.objectContaining({ type: "turn_canceled", turnId: firstTurnId }),
      ]);

      // Start replacement work while the slow snapshot is still blocked, then unblock the snapshot.
      harness.api.message.list = originalList;
      harness.autoComplete = true;
      const { turnId: secondTurnId } = await session.startTurn("replacement work");
      releaseList();
      await vi.advanceTimersByTimeAsync(50);

      // Even though T2 had already started, the late final tool update still belongs to T1.
      const toolUpdates = events.filter(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.callId === "call-slow-1",
      );
      expect(toolUpdates).toEqual([
        expect.objectContaining({
          turnId: firstTurnId,
          item: expect.objectContaining({ status: "running" }),
        }),
        expect.objectContaining({
          turnId: firstTurnId,
          item: expect.objectContaining({ status: "failed" }),
        }),
      ]);
      expect(terminalEvents(events)).toEqual([
        expect.objectContaining({ type: "turn_canceled", turnId: firstTurnId }),
        expect.objectContaining({ type: "turn_completed", turnId: secondTurnId }),
      ]);
    } finally {
      releaseList();
      await session.close();
      vi.useRealTimers();
    }
  });

  test("settles interrupt promptly when OpenCode clears active asynchronously without SSE", async () => {
    vi.useFakeTimers();
    const harness = new V2Harness();
    harness.autoComplete = false;
    harness.interrupt = async () => {
      // Simulate OpenCode's forked Fiber.interrupt: returns immediately while active clears ~35ms later
      // and the SSE event is missed.
      setTimeout(() => {
        harness.finishExecution("interrupted", false);
      }, 35);
      return { interrupted: true };
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("async interrupt work");
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.prompts).toEqual(["async interrupt work"]);
      let settled = false;
      const stop = (async () => {
        await session.interrupt();
        settled = true;
      })();
      // Fast-poll resolves in ~50ms of virtual time rather than waiting 5,000ms on scheduleRecovery.
      await vi.advanceTimersByTimeAsync(100);
      await stop;
      expect(settled).toBe(true);
      expect(terminalEvents(events)).toEqual([expect.objectContaining({ type: "turn_canceled" })]);
    } finally {
      await session.close();
      vi.useRealTimers();
    }
  });

  test("settles explicit Stop when OpenCode is inactive without a recorded terminal while keeping passive shutdown turns resumable", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    let interruptCalls = 0;
    harness.interrupt = async () => {
      interruptCalls += 1;
      return { interrupted: false };
    };
    let getCalls = 0;
    const originalGet = harness.api.session.get;
    harness.api.session.get = async (input, options) => {
      getCalls += 1;
      return originalGet(input, options);
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("missing terminal work");
      await expect.poll(() => harness.prompts).toEqual(["missing terminal work"]);
      // Simulate OpenCode inactive with time.idle < time.busy (no terminal recorded: #8681 / unresumed shutdown).
      harness.active = false;
      harness.info.outcome = "succeeded";
      harness.info.time.idle = 2;
      harness.info.time.busy = 3;

      // Passive reconciliation without Stop must keep the turn open for restart-resume.
      const passiveReads = harness.activeReads;
      harness.push({ id: "reconnect-passive", created: 10, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(passiveReads);
      expect(terminalEvents(events)).toEqual([]);

      // Explicit Stop settles immediately in one active read + outcome check + final snapshot (no polling).
      const activeBeforeStop = harness.activeReads;
      const getsBeforeStop = getCalls;
      await session.interrupt();
      expect(interruptCalls).toBe(1);
      expect(harness.activeReads - activeBeforeStop).toBe(1);
      expect(getCalls - getsBeforeStop).toBe(2);
      expect(terminalEvents(events)).toEqual([expect.objectContaining({ type: "turn_canceled" })]);

      // Follow-up send must succeed without colliding with the stopped turn.
      harness.autoComplete = true;
      await session.startTurn("follow-up work");
      await expect.poll(() => harness.prompts).toEqual(["missing terminal work", "follow-up work"]);
      await expect.poll(() => terminalEvents(events)).toHaveLength(2);
    } finally {
      await session.close();
    }
  });

  test("stops fast-polling during Stop after its bounded window when OpenCode stays active", async () => {
    vi.useFakeTimers();
    const harness = new V2Harness();
    harness.autoComplete = false;
    harness.interrupt = async () => ({ interrupted: true });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("slow cancel work");
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.prompts).toEqual(["slow cancel work"]);

      let settled = false;
      const stop = (async () => {
        await session.interrupt();
        settled = true;
      })();
      // Exhaust the 80 * 25ms = 2,000ms fast-poll budget while OpenCode remains genuinely active.
      await vi.advanceTimersByTimeAsync(2_100);
      expect(settled).toBe(false);
      const readsAfterBudget = harness.activeReads;
      expect(readsAfterBudget).toBeGreaterThanOrEqual(80);

      // No further fast-poll reads occur before the 5,000ms scheduleRecovery timer fires.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(harness.activeReads).toBe(readsAfterBudget);

      // Once OpenCode finally clears active, the 5,000ms recovery timer settles the pending Stop.
      harness.finishExecution("interrupted", false);
      await vi.advanceTimersByTimeAsync(3_000);
      await stop;
      expect(settled).toBe(true);
      expect(terminalEvents(events)).toEqual([expect.objectContaining({ type: "turn_canceled" })]);
    } finally {
      await session.close();
      vi.useRealTimers();
    }
  });

  test("reconciles live snapshots from the tail without re-reading page 1 of ascending history", async () => {
    const harness = new V2Harness();
    for (let i = 0; i < 60; i++) {
      harness.history.push(
        {
          id: `u-${i}`,
          type: "user",
          text: `prompt ${i}`,
          time: { created: i * 10 + 1 },
        },
        {
          id: `a-${i}`,
          type: "assistant",
          agent: "build",
          model: { providerID: "test", id: "model" },
          time: { created: i * 10 + 2, completed: i * 10 + 3 },
          content: [
            {
              type: "tool",
              id: `call-${i}`,
              name: "read",
              state: {
                status: "completed",
                input: { path: `file-${i}.ts` },
                content: [{ type: "text", text: `content-${i}` }],
                metadata: {},
              },
              time: { created: i * 10 + 2, ran: i * 10 + 2, completed: i * 10 + 3 },
            },
            { type: "text", text: `reply ${i}` },
          ],
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0.01,
        },
        {
          id: `i-${i}`,
          type: "idle",
          outcome: "succeeded",
          time: { created: i * 10 + 4 },
        },
      );
    }
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const liveCalls: Array<{ order?: string; cursor?: string; limit?: number }> = [];
    const originalList = harness.api.message.list;
    harness.api.message.list = async (input, options) => {
      liveCalls.push({ order: input.order, cursor: input.cursor, limit: input.limit });
      return originalList(input, options);
    };
    harness.prompt = async (input) => {
      harness.prompts.push(input.text);
      harness.history.push(
        {
          id: "u-live",
          type: "user",
          text: input.text,
          metadata: input.metadata,
          time: { created: 10_000 },
        },
        {
          id: "a-live",
          type: "assistant",
          agent: "build",
          model: { providerID: "test", id: "model" },
          time: { created: 10_000, completed: 11_000 },
          content: [{ type: "text", text: "tail reply" }],
          tokens: { input: 200, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0.02,
        },
      );
    };
    try {
      const result = await session.run("live prompt");
      expect(result.finalText).toBe("tail reply");
      expect(liveCalls.length).toBeGreaterThan(0);
      // Every live reconcile must fetch from the descending tail (never ascending from page 1).
      expect(liveCalls.every((call) => call.order === "desc" && call.cursor === undefined)).toBe(
        true,
      );
    } finally {
      await session.close();
    }
  });

  test("does not stall parent Stop during a burst of slow child SSE events", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const child: SessionInfo = { ...harness.info, id: "child", parentID: "session" };
    harness.api.session.list = async (input) => ({
      data: input?.parentID === "session" ? [child] : [],
      cursor: {},
    });
    let childGetReleased = false;
    let releaseChildGet!: () => void;
    const childGetGate = new Promise<void>((resolve) => {
      releaseChildGet = () => {
        childGetReleased = true;
        resolve();
      };
    });
    let blockChildGet = false;
    const originalGet = harness.api.session.get;
    harness.api.session.get = async (input, options) => {
      if (input.sessionID === "child") {
        if (blockChildGet) await childGetGate;
        return child;
      }
      return originalGet(input, options);
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("parent turn");
      await expect.poll(() => harness.prompts).toEqual(["parent turn"]);
      blockChildGet = true;
      for (let i = 0; i < 20; i++) {
        harness.push({
          id: `child-delta-${i}`,
          created: 100 + i,
          type: "session.text.delta",
          data: { sessionID: "child", assistantMessageID: "c-msg", ordinal: 0, delta: "x" },
        });
      }
      await session.interrupt();
      expect(childGetReleased).toBe(false);
      expect(terminalEvents(events)).toEqual([expect.objectContaining({ type: "turn_canceled" })]);
    } finally {
      releaseChildGet();
      await session.close();
    }
  });

  test("reconnects and reconciles when a half-open SSE stream stalls without activity", async () => {
    vi.useFakeTimers();
    const harness = new V2Harness();
    harness.autoComplete = false;
    let subscriptions = 0;
    const originalSubscribe = harness.api.event.subscribe;
    harness.api.event.subscribe = (options) => {
      subscriptions += 1;
      return originalSubscribe(options);
    };
    const session = new OpenCodeV2Session({
      connection: harness.connection,
      info: harness.info,
      config: { provider: "opencode", cwd: "/tmp/project" },
      logger: createTestLogger(),
      persist: true,
      requiresPaseoPlugin: false,
      streamIdleTimeoutMs: 120,
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.initialize();
    try {
      // Keepalive activity frames prevent spurious reconnects while the stream is healthy.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(40);
        harness.pingActivity();
      }
      expect(subscriptions).toBe(1);
      // Once the socket goes silent (no events or heartbeats), the watchdog reconnects and reconciles.
      await session.startTurn("finish on silent socket");
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.prompts).toEqual(["finish on silent socket"]);
      harness.finishExecution("succeeded", false);
      // Fire the 120ms watchdog deterministically, then let consume()'s 100ms reconnect delay run.
      await vi.advanceTimersByTimeAsync(125);
      vi.useRealTimers();
      await expect.poll(() => subscriptions).toBeGreaterThanOrEqual(2);
      await expect
        .poll(() => terminalEvents(events))
        .toEqual([expect.objectContaining({ type: "turn_completed" })]);
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });

  test("bridges multi-page tail updates and preserves structured output validation", async () => {
    const harness = new V2Harness();
    for (let i = 0; i < 40; i++) {
      harness.history.push(
        { id: `u-${i}`, type: "user", text: `old ${i}`, time: { created: i * 10 + 1 } },
        {
          id: `a-${i}`,
          type: "assistant",
          agent: "build",
          model: { providerID: "test", id: "model" },
          time: { created: i * 10 + 2, completed: i * 10 + 3 },
          content: [{ type: "text", text: `old reply ${i}` }],
        },
      );
    }
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const calls: Array<{ order?: string; cursor?: string }> = [];
    const originalList = harness.api.message.list;
    harness.api.message.list = async (input, options) => {
      calls.push({ order: input.order, cursor: input.cursor });
      return originalList(input, options);
    };
    harness.prompt = async (input) => {
      harness.prompts.push(input.text);
      harness.history.push({
        id: "u-structured",
        type: "user",
        text: input.text,
        metadata: input.metadata,
        time: { created: 10_000 },
      });
      // Add 30 intermediate assistant steps (> 1 tail page of 25) so cursor bridging is exercised
      // and the user message with paseoOutputSchema sits on page 2.
      for (let step = 0; step < 30; step++) {
        harness.history.push({
          id: `a-step-${step}`,
          type: "assistant",
          agent: "build",
          model: { providerID: "test", id: "model" },
          time: { created: 10_001 + step, completed: 10_002 + step },
          content: [{ type: "text", text: `intermediate prose ${step}` }],
        });
      }
      harness.history.push({
        id: "a-final",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 10_100, completed: 10_101 },
        content: [
          { type: "text", text: "prose to suppress" },
          {
            type: "tool",
            id: "out",
            name: "paseo_structured_output",
            time: { created: 10_100, ran: 10_100, completed: 10_101 },
            state: {
              status: "completed",
              input: { value: { ok: true } },
              content: [{ type: "text", text: "ok" }],
              metadata: { paseoStructuredOutput: { ok: true } },
            },
          },
        ],
      });
    };
    try {
      const result = await session.run("structured multi-step", {
        outputSchema: {
          type: "object",
          properties: { ok: { const: true } },
          required: ["ok"],
        },
      });
      expect(result.finalText).toBe('{"ok":true}');
      // Cursor bridging must never combine cursor with order, and must never fall back to order=asc.
      expect(calls.some((call) => call.order === "desc")).toBe(true);
      expect(calls.some((call) => call.cursor !== undefined && call.order === undefined)).toBe(
        true,
      );
      expect(calls.some((call) => call.order === "asc")).toBe(false);
    } finally {
      await session.close();
    }
  });
});

test("OpenCode v2 runtime safety retains shells, queued reports and shared executions", async () => {
  const harness = new V2Harness();
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
  try {
    expect(await session.canStopRuntime!()).toBe(true);
    harness.api.shell.list = async () => ({
      location: { directory: "/tmp/project" },
      data: [
        {
          id: "quiet-shell",
          status: "running",
          command: "sleep 7200",
          cwd: "/tmp/project",
          shell: "sh",
          file: "/tmp/out",
          metadata: {},
          time: { started: 1 },
        },
      ],
    });
    expect(await session.canStopRuntime!()).toBe(false);
    harness.api.shell.list = async () => ({ location: { directory: "/tmp/project" }, data: [] });
    harness.api.session.inbox.list = async () => [
      {
        id: "report",
        sessionID: session.id!,
        type: "synthetic",
        delivery: "queue",
        time: { created: 1 },
        payload: { text: "Background child finished" },
      },
    ];
    expect(await session.canStopRuntime!()).toBe(false);
    harness.api.session.inbox.list = async () => [];
    harness.api.session.active = async () => ({
      "unrelated-autonomous-session": { type: "running" },
    });
    expect(await session.canStopRuntime!()).toBe(false);
    harness.api.session.active = async () => ({});
    expect(await session.canStopRuntime!()).toBe(true);
    harness.api.shell.list = async () => {
      throw new Error("No shell inventory");
    };
    await expect(session.canStopRuntime!()).rejects.toThrow("No shell inventory");
  } finally {
    await session.close();
  }
});

test("OpenCode v2 runtime safety follows descendant locations before releasing the last lease", async () => {
  const harness = new V2Harness();
  const child = {
    ...harness.info,
    id: "child",
    parentID: harness.info.id,
    location: { directory: "/tmp/child-worktree" },
  };
  const locations: string[] = [];
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
  // A completed native child can still own a quiet shell in another location.
  harness.api.session.list = async (input) => ({
    data: input.parentID === session.id ? [child] : [],
    cursor: {},
  });
  let running = true;
  harness.api.shell.list = async (input) => {
    const directory = input?.location?.directory ?? "";
    locations.push(directory);
    return {
      location: { directory },
      data:
        directory === child.location.directory && running
          ? [
              {
                id: "child-shell",
                status: "running",
                command: "sleep 7200",
                cwd: directory,
                shell: "sh",
                file: "/tmp/out",
                metadata: {},
                time: { started: 1 },
              },
            ]
          : [],
    };
  };
  try {
    expect(await session.canStopRuntime!()).toBe(false);
    expect(locations).toEqual(["/tmp/project", "/tmp/child-worktree"]);
    running = false;
    expect(await session.canStopRuntime!()).toBe(true);
    await session.close();
    expect(harness.releases).toBe(1);
  } finally {
    await session.close();
  }
});

test("reconstructs only promoted session-owned running shells and reconciles exits", async () => {
  const harness = new V2Harness();
  harness.history.push({
    id: "assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: "tool",
        name: "shell",
        time: { created: 1 },
        state: {
          status: "completed",
          input: { description: "Watch tests", command: "sleep ours" },
          content: [{ type: "text", text: "" }],
          metadata: { status: "running", shellID: "ours" },
        },
      },
    ],
  });
  harness.api.message.list = async (input) =>
    input.cursor
      ? { data: [...harness.history], cursor: {} }
      : { data: [], cursor: { next: "second-page" } };
  let live = ["ours", "other"];
  harness.api.shell.list = async () => ({
    location: harness.info.location,
    data: live.map((id) => ({
      id,
      status: "running" as const,
      command: `sleep ${id}`,
      cwd: "/tmp/project",
      shell: "sh",
      file: "sh",
      metadata: { sessionID: id === "ours" ? harness.info.id : "other" },
      time: { started: 1 },
    })),
  });
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await expect
      .poll(() => events.findLast((event) => event.type === "background_work"))
      .toMatchObject({
        items: [{ id: "ours", kind: "shell", description: "Watch tests", command: "sleep ours" }],
      });
    live = [];
    harness.push({ id: "reconnect", created: 2, type: "server.connected", data: {} });
    await expect
      .poll(() => events.findLast((event) => event.type === "background_work"))
      .toMatchObject({ items: [] });
  } finally {
    await session.close();
  }
});

test("an exit received during shell listing cannot restore an old row", async () => {
  const harness = new V2Harness();
  harness.history.push({
    id: "assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: "tool",
        name: "shell",
        time: { created: 1 },
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: "" }],
          metadata: { status: "running", shellID: "shell" },
        },
      },
    ],
  });
  const shell = {
    id: "shell",
    status: "running" as const,
    command: "sleep 120",
    cwd: "/tmp/project",
    shell: "sh",
    file: "sh",
    metadata: { sessionID: harness.info.id },
    time: { started: 1 },
  };
  let listCount = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  harness.api.shell.list = async () => {
    listCount++;
    if (listCount === 2) {
      await gate;
      return { location: harness.info.location, data: [shell] };
    }
    return { location: harness.info.location, data: [] };
  };
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    harness.push({ id: "created", created: 2, type: "shell.created", data: { info: shell } });
    await expect.poll(() => listCount).toBe(2);
    harness.push({
      id: "exited",
      created: 3,
      type: "shell.exited",
      data: { id: "shell", status: "exited" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await expect.poll(() => listCount).toBeGreaterThan(2);
    await expect
      .poll(() => events.findLast((event) => event.type === "background_work"))
      .toMatchObject({ items: [] });
    expect(events.filter((event) => event.type === "background_work")).not.toContainEqual(
      expect.objectContaining({ items: [expect.objectContaining({ id: "shell" })] }),
    );
  } finally {
    release();
    await session.close();
  }
});

test("does not publish a shell list from a lost server generation", async () => {
  const harness = new V2Harness();
  let exit!: (error: Error) => void;
  Object.assign(harness.connection, {
    exited: new Promise<Error>((resolve) => {
      exit = resolve;
    }),
  });
  harness.history.push({
    id: "assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: "tool",
        name: "shell",
        time: { created: 1 },
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: "" }],
          metadata: { status: "running", shellID: "old" },
        },
      },
    ],
  });
  const shell = {
    id: "old",
    status: "running" as const,
    command: "sleep 120",
    cwd: "/tmp/project",
    shell: "sh",
    file: "sh",
    metadata: { sessionID: harness.info.id },
    time: { started: 1 },
  };
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  harness.api.shell.list = async () => {
    reads++;
    if (reads === 2) {
      await gate;
      return { location: harness.info.location, data: [shell] };
    }
    return { location: harness.info.location, data: [] };
  };
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    harness.push({ id: "created", created: 2, type: "shell.created", data: { info: shell } });
    await expect.poll(() => reads).toBe(2);
    exit(new Error("server exited"));
    await expect
      .poll(() => events.findLast((event) => event.type === "background_work"))
      .toMatchObject({ items: null });
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.filter((event) => event.type === "background_work")).not.toContainEqual(
      expect.objectContaining({ items: [expect.objectContaining({ id: "old" })] }),
    );
  } finally {
    release();
    await session.close();
  }
});

test("polls a live shell without rereading conversation history", async () => {
  const harness = new V2Harness();
  harness.history.push({
    id: "assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: "tool",
        name: "shell",
        time: { created: 1 },
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: "" }],
          metadata: { status: "running", shellID: "live" },
        },
      },
    ],
  });
  let historyReads = 0;
  let shellReads = 0;
  const readHistory = harness.api.message.list;
  harness.api.message.list = async (...args) => {
    historyReads++;
    return readHistory(...args);
  };
  harness.api.shell.list = async () => {
    shellReads++;
    return {
      location: harness.info.location,
      data: [
        {
          id: "live",
          status: "running",
          command: "sleep 120",
          cwd: "/tmp/project",
          shell: "sh",
          file: "sh",
          metadata: { sessionID: harness.info.id },
          time: { started: 1 },
        },
      ],
    };
  };
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await expect
      .poll(() => events.findLast((event) => event.type === "background_work"))
      .toMatchObject({ items: [{ id: "live" }] });
    const initialHistoryReads = historyReads;
    const initialShellReads = shellReads;
    await expect.poll(() => shellReads, { timeout: 7000 }).toBeGreaterThan(initialShellReads);
    expect(historyReads).toBe(initialHistoryReads);
  } finally {
    await session.close();
  }
}, 12000);

test("buffers tool promotion and shell events during background history bootstrap", async () => {
  const harness = new V2Harness();
  let historyReads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  harness.api.message.list = async () => {
    historyReads++;
    if (historyReads === 3) await gate;
    return { data: [], cursor: {} };
  };
  const shell = {
    id: "promoted",
    status: "running" as const,
    command: "sleep 120",
    cwd: "/tmp/project",
    shell: "sh",
    file: "sh",
    metadata: { sessionID: harness.info.id },
    time: { started: 1 },
  };
  harness.api.shell.list = async () => ({ location: harness.info.location, data: [shell] });
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await expect.poll(() => historyReads).toBeGreaterThanOrEqual(3);
    harness.push({
      id: "input",
      created: 2,
      type: "session.tool.input.started",
      durable: { aggregateID: harness.info.id, seq: 1, version: 1 },
      data: { sessionID: harness.info.id, assistantMessageID: "msg", id: "tool", name: "shell" },
    });
    harness.push({
      id: "input-ended",
      created: 3,
      type: "session.tool.input.ended",
      durable: { aggregateID: harness.info.id, seq: 2, version: 1 },
      data: {
        sessionID: harness.info.id,
        assistantMessageID: "msg",
        id: "tool",
        text: JSON.stringify({ description: "Watch tests", command: "sleep 120" }),
      },
    });
    harness.push({ id: "created", created: 3, type: "shell.created", data: { info: shell } });
    harness.push({
      id: "success",
      created: 4,
      type: "session.tool.success",
      durable: { aggregateID: harness.info.id, seq: 3, version: 2 },
      data: {
        sessionID: harness.info.id,
        assistantMessageID: "msg",
        id: "tool",
        executed: true,
        content: [{ type: "text", text: "" }],
        metadata: { status: "running", shellID: "promoted" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.filter((event) => event.type === "background_work")).toEqual([]);
    release();
    await expect
      .poll(() => events.findLast((event) => event.type === "background_work"))
      .toMatchObject({
        items: [{ id: "promoted", description: "Watch tests", command: "sleep 120" }],
      });
    harness.push({
      id: "next-input",
      created: 5,
      type: "session.tool.input.started",
      durable: { aggregateID: harness.info.id, seq: 4, version: 1 },
      data: { sessionID: harness.info.id, assistantMessageID: "next", id: "tool", name: "shell" },
    });
    harness.push({
      id: "next-success",
      created: 6,
      type: "session.tool.success",
      durable: { aggregateID: harness.info.id, seq: 5, version: 2 },
      data: {
        sessionID: harness.info.id,
        assistantMessageID: "next",
        id: "tool",
        executed: true,
        content: [{ type: "text", text: "" }],
        metadata: { status: "running", shellID: "second" },
      },
    });
    harness.api.shell.list = async () => ({
      location: harness.info.location,
      data: [shell, { ...shell, id: "second" }],
    });
    await expect
      .poll(() => events.findLast((event) => event.type === "background_work"))
      .toMatchObject({ items: [{ id: "promoted" }, { id: "second" }] });
  } finally {
    release();
    await session.close();
  }
});

test("retries failed background bootstrap and roster without losing stale work", async () => {
  vi.useFakeTimers();
  try {
    const { OpenCodeBackgroundInventory } = await import("./background-inventory.js");
    const harness = new V2Harness();
    harness.history.push({
      id: "assistant",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      time: { created: 1 },
      content: [
        {
          type: "tool",
          id: "tool",
          name: "shell",
          time: { created: 1 },
          state: {
            status: "completed",
            input: {},
            content: [{ type: "text", text: "" }],
            metadata: { status: "running", shellID: "live" },
          },
        },
      ],
    });
    let historyCalls = 0;
    let shellCalls = 0;
    let historyFails = true;
    let shellFails = true;
    harness.api.message.list = async () => {
      historyCalls++;
      if (historyFails) throw new Error("history unavailable");
      return { data: harness.history, cursor: {} };
    };
    harness.api.shell.list = async () => {
      shellCalls++;
      if (shellFails) throw new Error("roster unavailable");
      return {
        location: harness.info.location,
        data: [
          {
            id: "live",
            status: "running",
            command: "sleep 120",
            cwd: "/tmp/project",
            shell: "sh",
            file: "sh",
            metadata: { sessionID: harness.info.id },
            time: { started: 1 },
          },
        ],
      };
    };
    const inventory = new OpenCodeBackgroundInventory({
      id: harness.info.id,
      cwd: "/tmp/project",
      emit: () => {},
      report: () => {},
    });
    inventory.start(harness.api);
    await vi.advanceTimersByTimeAsync(0);
    expect(inventory.snapshot()).toBeNull();
    historyFails = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(historyCalls).toBe(2);
    expect(shellCalls).toBe(1);
    expect(inventory.snapshot()).toBeNull();
    inventory.observe({ id: "deleted", created: 1, type: "shell.deleted", data: { id: "other" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(shellCalls).toBe(1);
    shellFails = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(historyCalls).toBe(2);
    expect(inventory.snapshot()?.items).toMatchObject([{ id: "live", canStop: true }]);
    historyFails = true;
    inventory.start(harness.api);
    await vi.advanceTimersByTimeAsync(0);
    expect(inventory.snapshot()?.items).toEqual([
      { id: "live", kind: "shell", description: null, command: "sleep 120" },
    ]);
    await expect(inventory.stopItem("live")).rejects.toThrow("no longer available");
    historyFails = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(historyCalls).toBe(4);
    expect(inventory.snapshot()?.items).toMatchObject([{ id: "live", canStop: true }]);
    shellFails = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(inventory.snapshot()?.items).toMatchObject([{ id: "live" }]);
    inventory.disconnect();
    const stoppedCalls = shellCalls;
    await vi.advanceTimersByTimeAsync(15000);
    expect(shellCalls).toBe(stoppedCalls);
  } finally {
    vi.useRealTimers();
  }
});

test("does not retry a failed bootstrap from a disconnected generation", async () => {
  vi.useFakeTimers();
  try {
    const { OpenCodeBackgroundInventory } = await import("./background-inventory.js");
    const harness = new V2Harness();
    let reject!: (error: Error) => void;
    let calls = 0;
    const response = new Promise<Awaited<ReturnType<typeof harness.api.message.list>>>(
      (_, fail) => {
        reject = fail;
      },
    );
    harness.api.message.list = () => {
      calls++;
      return response;
    };
    const inventory = new OpenCodeBackgroundInventory({
      id: harness.info.id,
      cwd: "/tmp/project",
      emit: () => {},
      report: () => {},
    });
    inventory.start(harness.api);
    inventory.disconnect();
    reject(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(15000);
    expect(calls).toBe(1);
    expect(inventory.snapshot()).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("stops a selected promoted shell and retains its sibling", async () => {
  const harness = new V2Harness();
  harness.history.push({
    id: "assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    time: { created: 1 },
    content: ["one", "two"].map((id) => ({
      type: "tool" as const,
      id,
      name: "shell",
      time: { created: 1 },
      state: {
        status: "completed" as const,
        input: {},
        content: [{ type: "text" as const, text: "" }],
        metadata: { status: "running", shellID: id },
      },
    })),
  });
  let live = ["one", "two"];
  harness.api.shell.list = async () => ({
    location: harness.info.location,
    data: live.map((id) => ({
      id,
      status: "running" as const,
      command: `sleep ${id}`,
      cwd: "/tmp/project",
      shell: "sh",
      file: "sh",
      metadata: { sessionID: harness.info.id },
      time: { started: 1 },
    })),
  });
  harness.api.shell.remove = async ({ id }) => {
    live = live.filter((entry) => entry !== id);
    return { data: true };
  };
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await expect
      .poll(() => events.findLast((event) => event.type === "background_work"))
      .toMatchObject({ items: [{ id: "one" }, { id: "two" }] });
    await session.stopBackgroundWork!("one");
    expect(events.findLast((event) => event.type === "background_work")).toMatchObject({
      items: [{ id: "two" }],
    });
    await expect(session.stopBackgroundWork!("one")).rejects.toThrow();
  } finally {
    await session.close();
  }
});

test("closing during reconnect does not restart the background inventory", async () => {
  const harness = new V2Harness();
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await expect
    .poll(() => events.findLast((event) => event.type === "background_work"))
    .toMatchObject({ items: [] });
  let unblock!: () => void;
  let entered = false;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  harness.connection.bindSession = async () => {
    entered = true;
    await blocked;
  };
  let reads = 0;
  const original = harness.api.message.list;
  harness.api.message.list = (...args) => {
    reads++;
    return original(...args);
  };
  harness.push({ id: "reconnect-close", created: 2, type: "server.connected", data: {} });
  await expect.poll(() => entered).toBe(true);
  const closing = session.close();
  unblock();
  await closing;
  expect(reads).toBe(0);
});

test("keeps a shell available when its stop request times out", async () => {
  vi.useFakeTimers();
  try {
    const { OpenCodeBackgroundInventory } = await import("./background-inventory.js");
    const harness = new V2Harness();
    harness.history.push({
      id: "assistant",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      time: { created: 1 },
      content: [
        {
          type: "tool",
          id: "tool",
          name: "shell",
          time: { created: 1 },
          state: {
            status: "completed",
            input: {},
            content: [{ type: "text", text: "" }],
            metadata: { status: "running", shellID: "live" },
          },
        },
      ],
    });
    harness.api.shell.list = async () => ({
      location: harness.info.location,
      data: [
        {
          id: "live",
          status: "running",
          command: "sleep 120",
          cwd: "/tmp/project",
          shell: "sh",
          file: "sh",
          metadata: { sessionID: harness.info.id },
          time: { started: 1 },
        },
      ],
    });
    harness.api.shell.remove = () => new Promise(() => {});
    const inventory = new OpenCodeBackgroundInventory({
      id: harness.info.id,
      cwd: "/tmp/project",
      emit: () => {},
      report: () => {},
    });
    inventory.start(harness.api);
    await vi.advanceTimersByTimeAsync(0);
    expect(inventory.snapshot()?.items).toMatchObject([{ id: "live", canStop: true }]);
    const result = expect(inventory.stopItem("live")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10000);
    await result;
    expect(inventory.snapshot()?.items).toMatchObject([{ id: "live" }]);
    inventory.disconnect();
  } finally {
    vi.useRealTimers();
  }
});

test("keeps a live background shell visible and stoppable after its launch is rewound", async () => {
  const harness = new V2Harness();
  harness.history.push({
    id: "assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: "tool",
        name: "shell",
        time: { created: 1 },
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: "" }],
          metadata: { status: "running", shellID: "live" },
        },
      },
    ],
  });
  let live = true;
  harness.api.shell.list = async () => ({
    location: harness.info.location,
    data: live
      ? [
          {
            id: "live",
            status: "running",
            command: "sleep 180",
            cwd: "/tmp/project",
            shell: "sh",
            file: "sh",
            metadata: { sessionID: harness.info.id },
            time: { started: 1 },
          },
        ]
      : [],
  });
  harness.api.shell.remove = async () => {
    live = false;
    return { data: true };
  };
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await expect
      .poll(() => events.findLast((event) => event.type === "background_work"))
      .toMatchObject({ items: [{ id: "live", canStop: true }] });
    harness.history.length = 0;
    harness.push({
      id: "revert",
      created: 2,
      type: "session.revert.committed",
      durable: { aggregateID: harness.info.id, seq: 1, version: 1 },
      data: { sessionID: harness.info.id, to: "earlier" },
    });
    await expect
      .poll(() => events.filter((event) => event.type === "background_work").length)
      .toBeGreaterThanOrEqual(3);
    expect(events.findLast((event) => event.type === "background_work")).toMatchObject({
      items: [{ id: "live", canStop: true }],
    });
    harness.push({ id: "reconnect-after-rewind", created: 3, type: "server.connected", data: {} });
    await expect
      .poll(() => events.filter((event) => event.type === "background_work").length)
      .toBeGreaterThanOrEqual(5);
    expect(events.findLast((event) => event.type === "background_work")).toMatchObject({
      items: [{ id: "live", canStop: true }],
    });
    await session.stopBackgroundWork!("live");
    expect(events.findLast((event) => event.type === "background_work")).toMatchObject({
      items: [],
    });
  } finally {
    await session.close();
  }
});
