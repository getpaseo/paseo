import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { PROTOCOL_VERSION, type InitializeResponse } from "@agentclientprotocol/sdk";
import { ACPAgentSession, DEFAULT_ACP_CAPABILITIES } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { TraeACPAgentClient, traeActiveTurnSteeringAdapter } from "./trae-acp-agent.js";
import { AgentManager } from "../agent-manager.js";
import type { AgentClient, AgentSession, AgentStreamEvent } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  createSteeringPeerControl,
  type SteeringPeerOptions,
} from "./test-utils/steering-peer-control.js";

function terminalEvents(events: AgentStreamEvent[]): AgentStreamEvent[] {
  return events.filter(
    (event) =>
      event.type === "turn_completed" ||
      event.type === "turn_canceled" ||
      event.type === "turn_failed",
  );
}

interface SteeringHarnessOptions extends SteeringPeerOptions {
  generic?: boolean;
  start?: boolean;
}

async function createStdioSteeringHarness(options: SteeringHarnessOptions = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-acp-steering-"));
  const peer = await createSteeringPeerControl();
  const scriptPath = new URL("./test-utils/steering-acp-agent.mjs", import.meta.url);
  const command: [string, ...string[]] = [
    process.execPath,
    fileURLToPath(scriptPath),
    JSON.stringify({ ...options, controlPort: peer.port }),
  ];
  const clientOptions = { logger: createTestLogger(), command };
  const client = options.generic
    ? new GenericACPAgentClient(clientOptions)
    : new TraeACPAgentClient(clientOptions);
  // The manager receives a typed client adapter; sessions are observed only at
  // the public create/resume return boundary, without patching the real client.
  const created = Promise.withResolvers<AgentSession>();
  const observedClient: AgentClient = {
    provider: client.provider,
    capabilities: client.capabilities,
    resolveCreateConfig: client.resolveCreateConfig.bind(client),
    isCreateConfigUnattended: client.isCreateConfigUnattended.bind(client),
    listFeatures: client.listFeatures.bind(client),
    async createSession(...args) {
      const session = await client.createSession(...args);
      created.resolve(session);
      return session;
    },
    async resumeSession(...args) {
      const session = await client.resumeSession(...args);
      created.resolve(session);
      return session;
    },
    fetchCatalog: client.fetchCatalog.bind(client),
    isAvailable: client.isAvailable.bind(client),
  };
  const manager = new AgentManager({
    clients: { acp: observedClient },
    logger: createTestLogger(),
  });
  const control = peer.request;
  let session: AgentSession | undefined;
  onTestFinished(async () => {
    try {
      if (peer.connected() && session && !(await session.canStopRuntime?.())) {
        await control("ack-steer");
        await control("release");
      }
      for (const agent of manager.listAgents()) await manager.closeAgent(agent.id);
    } finally {
      await peer.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
  const agent = options.resume
    ? await manager.resumeAgentFromPersistence({
        provider: "acp",
        sessionId: "session-1",
        metadata: { cwd },
      })
    : await manager.createAgent({ provider: "acp", cwd }, undefined, { workspaceId: undefined });
  session = await created.promise;
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  const drained =
    options.start === false
      ? Promise.resolve()
      : (async () => {
          for await (const _event of manager.streamAgent(agent.id, "initial prompt", {
            clientMessageId: "initial-client",
          })) {
            /* Broadcast by manager. */
          }
        })();
  if (options.start !== false) {
    await manager.waitForAgentRunStart(agent.id);
    await control("prompt-started");
  }
  const activeSession = session;
  const turnId = manager.getAgent(agent.id)!.activeForegroundTurnId ?? "inactive-turn";
  const steer = (
    input: Parameters<NonNullable<AgentSession["steerActiveTurn"]>>[0] = "follow up",
    overrides: Partial<Parameters<NonNullable<AgentSession["steerActiveTurn"]>>[1]> = {},
  ) => {
    if (!activeSession.steerActiveTurn) throw new Error("ACP active-turn steering is missing");
    return activeSession.steerActiveTurn(input, { expectedTurnId: turnId, ...overrides });
  };
  const dispatch = (input = "follow up", clearPendingPermissions = false) =>
    manager.steerOrReplaceActiveTurn(agent.id, input, {
      clientMessageId: "steer-client",
      clearPendingPermissions,
    });
  const finish = async () => {
    await control("release");
    await drained;
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: "turn_completed", turnId }),
    ]);
  };
  return {
    session,
    drained,
    events,
    turnId,
    steer,
    dispatch,
    finish,
    control,
    manager,
    agentId: agent.id,
  };
}

describe("ACP active-turn steering over stdio", () => {
  test("Trae injects into the existing turn without canceling or prompting again", async () => {
    const h = await createStdioSteeringHarness();
    await expect(h.steer()).resolves.toEqual({ status: "accepted" });
    await expect(h.control("state")).resolves.toMatchObject({
      calls: [
        { method: "initialize", params: expect.any(Object) },
        { method: "session/new", params: expect.any(Object) },
        {
          method: "session/prompt",
          params: { sessionId: "session-1", prompt: [{ type: "text", text: "initial prompt" }] },
        },
        {
          method: "_session/steering",
          params: { sessionId: "session-1", prompt: [{ type: "text", text: "follow up" }] },
        },
      ],
    });
    expect(await h.session.canStopRuntime?.()).toBe(false);
    expect(h.events.filter((event) => event.type === "turn_started")).toEqual([
      { type: "turn_started", provider: "acp", turnId: h.turnId },
    ]);
    expect(terminalEvents(h.events)).toEqual([]);
    await h.finish();
  });
});

async function expectSteeringTurnUnchanged(
  h: Awaited<ReturnType<typeof createStdioSteeringHarness>>,
  steeringRequests: number,
  sessionMethod = "session/new",
) {
  const state = await h.control("state");
  expect(state.calls).toEqual([
    expect.objectContaining({ method: "initialize" }),
    expect.objectContaining({ method: sessionMethod }),
    expect.objectContaining({ method: "session/prompt" }),
    ...Array.from({ length: steeringRequests }, () =>
      expect.objectContaining({ method: "_session/steering" }),
    ),
  ]);
  expect(h.manager.getAgent(h.agentId)).toMatchObject({
    activeForegroundTurnId: h.turnId,
    activeTurnId: h.turnId,
    lifecycle: "running",
  });
  expect(terminalEvents(h.events)).toEqual([]);
}

describe("ACP active-turn steering over stdio", () => {
  test("manager records an accepted steer in the original turn", async () => {
    const h = await createStdioSteeringHarness();
    await expect(h.dispatch()).resolves.toEqual({ status: "steered" });
    await expectSteeringTurnUnchanged(h, 1);
    expect(h.manager.fetchTimeline(h.agentId, { limit: 0 }).rows).toEqual([
      expect.objectContaining({
        turnId: h.turnId,
        item: expect.objectContaining({
          type: "user_message",
          text: "initial prompt",
          clientMessageId: "initial-client",
        }),
      }),
      expect.objectContaining({
        turnId: h.turnId,
        item: expect.objectContaining({
          type: "user_message",
          text: "follow up",
          clientMessageId: "steer-client",
        }),
      }),
    ]);
    await h.finish();
  });

  test.each(["load", "resume"] as const)(
    "negotiates steering on a session restored via %s",
    async (resume) => {
      const h = await createStdioSteeringHarness({ resume });
      await expect(h.steer()).resolves.toEqual({ status: "accepted" });
      await expectSteeringTurnUnchanged(h, 1, `session/${resume}`);
      await h.finish();
    },
  );

  test.each([
    { name: "missing", initialize: {} },
    { name: "false", initialize: { _meta: { steering: { supported: false } } } },
    {
      name: "wrong level",
      initialize: {
        agentCapabilities: { loadSession: true, _meta: { steering: { supported: true } } },
      },
    },
    { name: "string true", initialize: { _meta: { steering: { supported: "true" } } } },
  ])(
    "does not inject when capability is $name, including restored connections",
    async ({ initialize }) => {
      const h = await createStdioSteeringHarness({ initialize, resume: "load" });
      await expect(h.steer()).resolves.toEqual({ status: "unavailable" });
      await expectSteeringTurnUnchanged(h, 0, "session/load");
      await h.finish();
    },
  );

  test("generic ACP stays unavailable even if the peer advertises Trae steering", async () => {
    const h = await createStdioSteeringHarness({ generic: true });
    await expect(h.steer()).resolves.toEqual({ status: "unavailable" });
    await expectSteeringTurnUnchanged(h, 0);
    await h.finish();
  });

  test("a mismatched turn cannot receive the steer or release permissions", async () => {
    const h = await createStdioSteeringHarness();
    await h.control("permissions");
    await vi.waitFor(() => expect(h.session.getPendingPermissions()).toHaveLength(2));
    await expect(
      h.steer("wrong turn", { expectedTurnId: "another-turn", clearPendingPermissions: true }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(h.session.getPendingPermissions()).toHaveLength(2);
    await expectSteeringTurnUnchanged(h, 0);
    await h.finish();
  });

  test("converts structured steering content using the normal ACP prompt format", async () => {
    const h = await createStdioSteeringHarness();
    const prompt = [
      { type: "text", text: "look at this" },
      { type: "image", data: "AA==", mimeType: "image/png" },
    ] satisfies Parameters<NonNullable<AgentSession["steerActiveTurn"]>>[0];
    await expect(h.steer(prompt)).resolves.toEqual({ status: "accepted" });
    const state = await h.control("state");
    expect(state.calls).toContainEqual({
      method: "_session/steering",
      params: { sessionId: "session-1", prompt },
    });
    await h.finish();
  });

  test.each([
    { name: "queued", receipt: { outcome: "queued" }, error: "did not confirm injection" },
    { name: "missing outcome", receipt: {}, error: "did not confirm injection" },
    { name: "null", receipt: null, error: "did not confirm injection" },
    { name: "array", receipt: [], error: "did not confirm injection" },
    { name: "primitive", receipt: "injected", error: "did not confirm injection" },
    { name: "RPC failure", rpcError: true, error: "steering failed" },
  ])(
    "manager surfaces $name without cancellation, replacement, retry, or permission release",
    async (options) => {
      const h = await createStdioSteeringHarness(options);
      await h.control("permissions");
      await vi.waitFor(() => expect(h.session.getPendingPermissions()).toHaveLength(2));
      await expect(h.dispatch("follow up", true)).rejects.toThrow(options.error);
      expect(h.session.getPendingPermissions()).toHaveLength(2);
      await expect(h.control("state")).resolves.toMatchObject({ order: [], permissionResults: [] });
      await expectSteeringTurnUnchanged(h, 1);
      expect(h.manager.getTimeline(h.agentId)).not.toContainEqual(
        expect.objectContaining({ clientMessageId: "steer-client" }),
      );
      await h.finish();
    },
  );

  test("denies every pending permission only after the successful injection receipt", async () => {
    const h = await createStdioSteeringHarness({ holdReceipt: true });
    await h.control("permissions");
    await vi.waitFor(() => expect(h.session.getPendingPermissions()).toHaveLength(2));
    const steering = h.dispatch("follow up", true);
    await h.control("steering-started");
    expect(h.session.getPendingPermissions()).toHaveLength(2);
    await expect(h.control("state")).resolves.toMatchObject({ order: [], permissionResults: [] });
    await h.control("ack-steer");
    await expect(steering).resolves.toEqual({ status: "steered" });
    expect(h.session.getPendingPermissions()).toEqual([]);
    await expect(h.control("permission-results")).resolves.toMatchObject({
      order: ["injected", "deny", "deny"],
      permissionResults: [
        { outcome: { outcome: "selected", optionId: "deny" } },
        { outcome: { outcome: "selected", optionId: "deny" } },
      ],
    });
    await expectSteeringTurnUnchanged(h, 1);
    await h.finish();
  });

  test("leaves permissions pending when clearPendingPermissions is absent", async () => {
    const h = await createStdioSteeringHarness();
    await h.control("permissions");
    await vi.waitFor(() => expect(h.session.getPendingPermissions()).toHaveLength(2));
    await expect(h.steer()).resolves.toEqual({ status: "accepted" });
    expect(h.session.getPendingPermissions()).toHaveLength(2);
    await expect(h.control("state")).resolves.toMatchObject({
      order: ["injected"],
      permissionResults: [],
    });
    await expectSteeringTurnUnchanged(h, 1);
    await h.finish();
  });

  test("manager retains interrupt-and-replace fallback when capability is missing", async () => {
    const h = await createStdioSteeringHarness({ initialize: {} });
    const result = await h.dispatch();
    expect(result.status).toBe("replaced");
    if (result.status !== "replaced") throw new Error("Expected replacement iterator");
    for await (const _event of result.iterator) {
      /* Drain replacement. */
    }
    const state = await h.control("state");
    expect(state.calls).toEqual([
      expect.objectContaining({ method: "initialize" }),
      expect.objectContaining({ method: "session/new" }),
      expect.objectContaining({ method: "session/prompt" }),
      { method: "session/cancel", params: { sessionId: "session-1" } },
      expect.objectContaining({
        method: "session/prompt",
        params: expect.objectContaining({ prompt: [{ type: "text", text: "follow up" }] }),
      }),
    ]);
  });
});

describe("Trae steering protocol validation", () => {
  test.each([
    undefined,
    null,
    false,
    [],
    "true",
    {},
    { steering: null },
    { steering: [] },
    { steering: { supported: 1 } },
    { steering: { supported: "true" } },
  ])("rejects malformed or unsupported initialize metadata %j", (_meta) => {
    const initialize: InitializeResponse = JSON.parse(
      JSON.stringify({ protocolVersion: PROTOCOL_VERSION, _meta }),
    );
    expect(traeActiveTurnSteeringAdapter.isSupported(initialize)).toBe(false);
  });

  test("only the strict top-level true capability enables steering", () => {
    expect(
      traeActiveTurnSteeringAdapter.isSupported({
        protocolVersion: PROTOCOL_VERSION,
        _meta: { steering: { supported: true } },
      }),
    ).toBe(true);
    expect(
      traeActiveTurnSteeringAdapter.isSupported({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { _meta: { steering: { supported: true } } },
      }),
    ).toBe(false);
  });

  test.each([null, [], "injected", {}, { outcome: "queued" }, { outcome: true }])(
    "rejects receipt %j without retrying",
    async (receipt) => {
      const calls: string[] = [];
      const connection = {
        async extMethod(method: string): Promise<Record<string, unknown>> {
          calls.push(method);
          return JSON.parse(JSON.stringify(receipt));
        },
      };
      await expect(
        traeActiveTurnSteeringAdapter.steer({
          connection,
          sessionId: "session-1",
          prompt: [],
        }),
      ).rejects.toThrow("did not confirm injection");
      expect(calls).toEqual(["_session/steering"]);
    },
  );

  test("reports unavailable before initialization without launching a provider", async () => {
    const session = new ACPAgentSession(
      { provider: "acp", cwd: tmpdir() },
      {
        provider: "acp",
        logger: createTestLogger(),
        defaultCommand: [process.execPath],
        defaultModes: [],
        capabilities: DEFAULT_ACP_CAPABILITIES,
        activeTurnSteeringAdapter: traeActiveTurnSteeringAdapter,
      },
    );
    onTestFinished(() => session.close());
    expect(session.id).toBeNull();
    await expect(
      session.steerActiveTurn("follow up", { expectedTurnId: "absent-turn" }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  test("reports unavailable before the first turn", async () => {
    const h = await createStdioSteeringHarness({ start: false });
    const before = await h.control("state");
    await expect(h.steer()).resolves.toEqual({ status: "unavailable" });
    expect(await h.control("state")).toEqual(before);
  });

  test("reports unavailable after the original turn completes", async () => {
    const h = await createStdioSteeringHarness();
    await h.finish();
    const before = await h.control("state");
    await expect(h.steer()).resolves.toEqual({ status: "unavailable" });
    expect(await h.control("state")).toEqual(before);
  });

  test("reports unavailable after closing the session", async () => {
    const h = await createStdioSteeringHarness();
    await h.finish();
    await h.session.close();
    await expect(h.steer()).resolves.toEqual({ status: "unavailable" });
  });

  test("reports unavailable after the provider disconnects", async () => {
    const h = await createStdioSteeringHarness();
    await h.control("disconnect");
    await h.drained;
    expect(terminalEvents(h.events)).toEqual([
      expect.objectContaining({ type: "turn_failed", turnId: h.turnId }),
    ]);
    const before = await h.control("state");
    await expect(h.steer()).resolves.toEqual({ status: "unavailable" });
    expect(await h.control("state")).toEqual(before);
  });
});

describe("ACP steering permission release", () => {
  test("leaves permissions raised during release for the user's next decision", async () => {
    const h = await createStdioSteeringHarness();
    await h.control("permissions");
    await vi.waitFor(() => expect(h.session.getPendingPermissions()).toHaveLength(2));
    const session = h.session;
    if (!(session instanceof ACPAgentSession)) throw new Error("Expected the real ACP client");
    let raisedNextPermission = false;
    h.session.subscribe((event) => {
      if (event.type !== "permission_resolved" || raisedNextPermission) return;
      raisedNextPermission = true;
      // Resolution callbacks may synchronously raise a new request for subsequent work.
      void session.requestPermission({
        sessionId: "session-1",
        toolCall: {
          toolCallId: "next-work",
          title: "Next work",
          kind: "execute",
          status: "pending",
        },
        options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
      });
    });
    await expect(h.dispatch("follow up", true)).resolves.toEqual({ status: "steered" });
    expect(raisedNextPermission).toBe(true);
    expect(h.session.getPendingPermissions()).toHaveLength(1);
    await expect(h.control("permission-results")).resolves.toMatchObject({
      order: ["injected", "deny", "deny"],
    });
    await h.finish();
  });
});

// A command-inventory notification follows the late reply on the same ACP
// output stream. Observing it through listCommands proves the SDK consumed that
// reply, without reaching into the session's private connection or SDK promises.
async function observeLateReply(h: Awaited<ReturnType<typeof createStdioSteeringHarness>>) {
  await h.control("ack-steer");
  await h.control("reply-sent");
  await vi.waitFor(async () =>
    expect(await h.session.listCommands?.()).toEqual([
      {
        name: "reply-observed",
        description: "Steering reply barrier",
        argumentHint: "",
        kind: "command",
      },
    ]),
  );
}

async function startHeldSteering(h: Awaited<ReturnType<typeof createStdioSteeringHarness>>) {
  const settlements: unknown[] = [];
  const result = h.dispatch("follow up", true).then(
    (admission) => {
      settlements.push(admission);
      return admission;
    },
    (error: unknown) => {
      settlements.push(error);
      return error;
    },
  );
  await h.control("steering-started");
  return { settlements, result };
}

const timeoutMessage = "Active-turn steering timed out after 10000ms; delivery is unknown";

describe("ACP steering deadlines over stdio", () => {
  test("keeps the original turn running beyond the deadline after acknowledgement", async () => {
    const h = await createStdioSteeringHarness();
    await expect(h.dispatch()).resolves.toEqual({ status: "steered" });
    // Here elapsed time is the behavior under test, not synchronization between
    // the peer and client. All protocol ordering uses explicit barriers.
    await delay(10_100);
    await expectSteeringTurnUnchanged(h, 1);
    await h.finish();
  });

  test.each([false, true])(
    "expires without side effects and ignores a late reply (RPC error: %s)",
    async (rpcError) => {
      const h = await createStdioSteeringHarness({ holdReceipt: true, rpcError });
      await h.control("permissions");
      await vi.waitFor(() => expect(h.session.getPendingPermissions()).toHaveLength(2));
      const startedAt = performance.now();
      const held = await startHeldSteering(h);
      expect(held.settlements).toEqual([]);
      const result = await held.result;
      expect(result).toBeInstanceOf(Error);
      expect(result).toMatchObject({ message: timeoutMessage });
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(10_000);
      expect(h.session.getPendingPermissions()).toHaveLength(2);
      await expectSteeringTurnUnchanged(h, 1);
      const timeline = structuredClone(h.manager.getTimeline(h.agentId));
      expect(timeline).not.toContainEqual(
        expect.objectContaining({ clientMessageId: "steer-client" }),
      );
      await expect(h.control("state")).resolves.toMatchObject({ order: [], permissionResults: [] });
      await observeLateReply(h);
      expect(held.settlements).toEqual([result]);
      expect(h.session.getPendingPermissions()).toHaveLength(2);
      expect(h.manager.getTimeline(h.agentId)).toEqual(timeline);
      await expect(h.control("state")).resolves.toMatchObject({ permissionResults: [] });
      await expectSteeringTurnUnchanged(h, 1);
      await h.finish();
    },
  );

  test("lets a queued Stop execute after the steering deadline", async () => {
    const h = await createStdioSteeringHarness({ holdReceipt: true });
    const held = await startHeldSteering(h);
    const stopped: unknown[] = [];
    const stop = h.manager.cancelAgentRun(h.agentId).then((result) => {
      stopped.push(result);
      return result;
    });
    await expectSteeringTurnUnchanged(h, 1);
    expect(stopped).toEqual([]);
    expect(await held.result).toMatchObject({ message: timeoutMessage });
    await expect(stop).resolves.toEqual({ status: "settled" });
    expect(h.manager.getAgent(h.agentId)).toMatchObject({
      lifecycle: "idle",
      activeTurnId: null,
      activeForegroundTurnId: null,
    });
    const beforeReply = await h.control("state");
    expect(beforeReply.calls).toEqual([
      expect.objectContaining({ method: "initialize" }),
      expect.objectContaining({ method: "session/new" }),
      expect.objectContaining({ method: "session/prompt" }),
      expect.objectContaining({ method: "_session/steering" }),
      { method: "session/cancel", params: { sessionId: "session-1" } },
    ]);
    const timeline = structuredClone(h.manager.getTimeline(h.agentId));
    await observeLateReply(h);
    expect(h.manager.getTimeline(h.agentId)).toEqual(timeline);
    expect(h.manager.getAgent(h.agentId)).toMatchObject({ lifecycle: "idle", activeTurnId: null });
    expect(await h.control("state")).toMatchObject({ calls: beforeReply.calls });
    await h.finish();
  });

  test("drains an original completion buffered while steering waits", async () => {
    const h = await createStdioSteeringHarness({ holdReceipt: true });
    const completed = Promise.withResolvers<void>();
    h.session.subscribe((event) => {
      if (event.type === "turn_completed") completed.resolve();
    });
    const held = await startHeldSteering(h);
    await h.control("release");
    await completed.promise;
    expect(h.manager.getAgent(h.agentId)).toMatchObject({
      lifecycle: "running",
      activeForegroundTurnId: h.turnId,
    });
    expect(held.settlements).toEqual([]);
    expect(await held.result).toMatchObject({ message: timeoutMessage });
    await h.finish();
    expect(h.manager.getAgent(h.agentId)).toMatchObject({
      lifecycle: "idle",
      activeTurnId: null,
      activeForegroundTurnId: null,
    });
    const beforeReply = await h.control("state");
    expect(beforeReply.calls).toEqual([
      expect.objectContaining({ method: "initialize" }),
      expect.objectContaining({ method: "session/new" }),
      expect.objectContaining({ method: "session/prompt" }),
      expect.objectContaining({ method: "_session/steering" }),
    ]);
    const timeline = structuredClone(h.manager.getTimeline(h.agentId));
    await observeLateReply(h);
    expect(h.manager.getTimeline(h.agentId)).toEqual(timeline);
    expect(h.manager.getAgent(h.agentId)).toMatchObject({ lifecycle: "idle", activeTurnId: null });
    expect(await h.control("state")).toMatchObject({ calls: beforeReply.calls });
  });
});
