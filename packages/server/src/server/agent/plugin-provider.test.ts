import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentClient, AgentStreamEvent } from "./agent-sdk-types.js";
import { PluginAgentClientRegistry } from "./plugin-provider.js";
import {
  isStaleProviderSessionError,
  StaleProviderSessionError,
} from "./stale-provider-session-error.js";

const CAPABILITIES = [
  "prompt.message",
  "session.configure",
  "session.persistence",
  "session.subsession",
  "permission",
] as const;

interface ProviderHarnessOptions {
  capabilities?: ProviderConnection["capabilities"];
  completeTurn?: boolean;
  openChildren?: (rootSessionId: string, emit: (event: ProviderEvent) => void) => void;
  handleInput?: (input: ProviderInput, emit: (event: ProviderEvent) => void) => Promise<boolean>;
}

function createProviderHarness(options: ProviderHarnessOptions = {}) {
  let listener: ((event: ProviderEvent) => void) | null = null;
  let closeCount = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const inputs: ProviderInput[] = [];
  const emit = (event: ProviderEvent) => listener?.(event);
  const capabilities = options.capabilities ?? CAPABILITIES;

  const connection: ProviderConnection = {
    version: 1,
    capabilities,
    async send(input) {
      inputs.push(input);
      if (await options.handleInput?.(input, emit)) return;
      if (input.type === "catalog") {
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: {
            models: [{ id: "plugin-model", label: "Plugin model" }],
            modes: [{ id: "build", label: "Build" }],
            thinkingOptions: [{ id: "deep", label: "Deep" }],
            defaultModel: "plugin-model",
            defaultMode: "build",
            defaultThinkingOption: "deep",
          },
        });
        return;
      }
      if (input.type === "session.open") {
        emit({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities,
          restoration: "core",
          persistence: { version: 1, data: { token: "root" } },
          cwd: input.config.cwd,
        });
        emit({
          type: "session.config",
          sessionId: input.sessionId,
          config: {
            model: "plugin-model",
            mode: "build",
            models: [{ id: "plugin-model", label: "Plugin model" }],
            modes: [{ id: "build", label: "Build" }],
            thinkingOptions: [],
            settings: [
              {
                type: "select",
                id: "voice",
                label: "Voice",
                value: "direct",
                options: [{ label: "Direct", value: "direct" }],
              },
            ],
          },
        });
        emit({
          type: "session.opened",
          sessionId: "child-1",
          parentSessionId: input.sessionId,
          capabilities: [],
          restoration: "parent",
          title: "Plugin child",
          cwd: input.config.cwd,
        });
        emit({
          type: "timeline.item",
          sessionId: "child-1",
          item: { type: "assistant_message", id: "child-message", text: "Child result" },
        });
        emit({
          type: "session.turn",
          sessionId: "child-1",
          turnId: "child-turn",
          state: "completed",
        });
        emit({ type: "session.ready", sessionId: "child-1" });
        options.openChildren?.(input.sessionId, emit);
        emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        return;
      }
      if (input.type === "session.prompt") {
        emit({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: { type: "turn", turnId: "turn-1" },
        });
        emit({
          type: "session.turn",
          sessionId: input.sessionId,
          turnId: "turn-1",
          state: "started",
        });
        emit({
          type: "timeline.item",
          sessionId: input.sessionId,
          item: { type: "assistant_message", id: "answer", text: "Hel" },
        });
        emit({
          type: "timeline.item",
          sessionId: input.sessionId,
          item: { type: "assistant_message", id: "answer", text: "Hello" },
        });
        emit({
          type: "session.permission",
          sessionId: input.sessionId,
          request: { id: "permission-1", name: "write", kind: "tool" },
        });
        if (options.completeTurn !== false) {
          emit({
            type: "session.turn",
            sessionId: input.sessionId,
            turnId: "turn-1",
            state: "completed",
          });
        }
        return;
      }
      if (input.type === "session.permission") {
        emit({
          type: "session.permission_resolved",
          sessionId: input.sessionId,
          permissionId: input.permissionId,
        });
        return;
      }
      if (input.type === "session.configure") {
        emit({
          type: "session.config",
          sessionId: input.sessionId,
          config: {
            model: input.changes.model ?? "plugin-model",
            mode: "build",
            models: [{ id: "plugin-model", label: "Plugin model" }],
            modes: [{ id: "build", label: "Build" }],
            thinkingOptions: [],
            settings: [],
          },
        });
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      if (input.type === "session.close") {
        emit({ type: "session.closed", sessionId: input.sessionId });
      }
      if ("requestId" in input) {
        emit({ type: "request.completed", requestId: input.requestId });
      }
    },
    onEvent(nextListener) {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = null;
      };
    },
    async close() {
      closeCount += 1;
      resolveClosed();
    },
  };

  const registration: ProviderRegistration = {
    id: "plugin-direct",
    label: "Plugin direct",
    async connect() {
      return connection;
    },
  };

  return {
    registration,
    emit,
    inputs,
    closeCount: () => closeCount,
    waitForClose: () => closed,
  };
}

function eventsOfType(events: AgentStreamEvent[], type: AgentStreamEvent["type"]) {
  return events.filter((event) => event.type === type);
}

function openNestedChildren(rootSessionId: string, emit: (event: ProviderEvent) => void) {
  for (const [sessionId, parentSessionId] of [
    ["a", rootSessionId],
    ["a.b", "a"],
    ["a.b.c", "a.b"],
    ["sibling", rootSessionId],
  ]) {
    emit({
      type: "session.opened",
      sessionId,
      parentSessionId,
      toolCallId: `${sessionId}-task`,
      capabilities: [],
      restoration: "parent",
      cwd: "/workspace",
    });
    emit({
      type: "timeline.item",
      sessionId,
      item: { type: "assistant_message", id: `${sessionId}-message`, text: sessionId },
    });
    emit({
      type: "session.turn",
      sessionId,
      turnId: `${sessionId}-turn`,
      state: "completed",
    });
  }
}

function expectNestedChildren(events: AgentStreamEvent[]) {
  for (const [id, parentSubagentId] of [
    ["a", null],
    ["a.b", "a"],
    ["a.b.c", "a.b"],
    ["sibling", null],
  ]) {
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({
          type: "upsert",
          id,
          parentSubagentId,
          toolCallId: `${id}-task`,
          status: "running",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({
          type: "timeline",
          id,
          item: expect.objectContaining({ text: id }),
        }),
      }),
    );
  }
}

describe("PluginAgentClientRegistry", () => {
  test.each([false, true])(
    "contains a failed session open while send is pending: %s",
    async (pendingSend) => {
      let listener: ((event: ProviderEvent) => void) | undefined;
      const unhandled: unknown[] = [];
      const observeUnhandled = (reason: unknown) => unhandled.push(reason);
      const registry = new PluginAgentClientRegistry(createTestLogger());
      registry.replace([
        {
          id: "failing-provider",
          label: "Failing provider",
          async connect() {
            return {
              version: 1,
              capabilities: ["session.persistence"],
              async send(input) {
                if (input.type !== "session.open") return;
                listener?.({
                  type: "request.failed",
                  requestId: input.requestId,
                  error: { message: "OMP persistent session registration is in progress" },
                });
                // Keep acceptance pending across a Node event-loop turn, as IPC can do.
                if (pendingSend) await nextTurn();
              },
              onEvent(nextListener) {
                listener = nextListener;
                return () => {
                  listener = undefined;
                };
              },
              async close() {},
            };
          },
        },
      ]);
      process.on("unhandledRejection", observeUnhandled);
      try {
        await expect(
          registry.clients()["failing-provider"]!.createSession({
            provider: "failing-provider",
            cwd: "/workspace",
          }),
        ).rejects.toThrow("OMP persistent session registration is in progress");
        await nextTurn();
        expect(unhandled).toEqual([]);
      } finally {
        await registry.shutdown();
        process.off("unhandledRejection", observeUnhandled);
      }
    },
  );

  test("preserves nested provider child ownership during opening", async () => {
    const harness = createProviderHarness({ openChildren: openNestedChildren });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const session = await registry.clients()[harness.registration.id]!.createSession({
      provider: harness.registration.id,
      cwd: "/workspace",
    });
    try {
      const events: AgentStreamEvent[] = [];
      for await (const event of session.streamHistory()) events.push(event);
      expectNestedChildren(events);
    } finally {
      await session.close();
      registry.replace([]);
    }
  });

  test("preserves nested provider child ownership during live events", async () => {
    const harness = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const session = await registry.clients()[harness.registration.id]!.createSession({
      provider: harness.registration.id,
      cwd: "/workspace",
    });
    try {
      const events: AgentStreamEvent[] = [];
      session.subscribe((event) => events.push(event));
      const open = harness.inputs.find((input) => input.type === "session.open")!;
      openNestedChildren(open.sessionId, harness.emit);
      expectNestedChildren(events);
    } finally {
      await session.close();
      registry.replace([]);
    }
  });

  test("gates persistence operations on negotiated provider capabilities", async () => {
    const harness = createProviderHarness({ capabilities: ["session.persistence"] });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id]!;

    await expect(client.isAvailable()).resolves.toBe(true);
    expect(client.capabilities).toMatchObject({
      supportsSessionPersistence: true,
      supportsSessionListing: false,
    });
    await expect(client.listImportableSessions?.()).resolves.toEqual([]);

    const persistence = {
      provider: harness.registration.id,
      sessionId: 'plugin:{"version":1,"data":{"token":"root"}}',
      metadata: { pluginProviderPersistence: { version: 1, data: { token: "root" } } },
    };
    await expect(client.archiveNativeSession?.(persistence)).resolves.toBeUndefined();
    await expect(client.unarchiveNativeSession?.(persistence)).resolves.toBeUndefined();
    expect(harness.inputs).toEqual([]);
    await registry.shutdown();
  });

  test("terminalizes an active turn exactly once when its plugin provider is removed", async () => {
    const harness = createProviderHarness({ completeTurn: false });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id]!;
    const session = await client.createSession({
      provider: harness.registration.id,
      cwd: "/workspace",
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const run = session.run("hello", { clientMessageId: "active-message" });
    void run.catch(() => undefined);
    await expect.poll(() => eventsOfType(events, "turn_started")).toHaveLength(1);

    registry.replace([]);

    await expect
      .poll(() => eventsOfType(events, "turn_failed"))
      .toEqual([
        expect.objectContaining({
          type: "turn_failed",
          provider: harness.registration.id,
          turnId: "turn-1",
          error: "Provider connection closed",
        }),
      ]);
    await expect(run).rejects.toThrow("Provider connection closed");
    await expect.poll(harness.closeCount).toBe(1);

    registry.replace([]);
    expect(eventsOfType(events, "turn_failed")).toHaveLength(1);
  });

  test("closes a stale session after its plugin provider is replaced", async () => {
    const old = createProviderHarness();
    const next = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());

    try {
      registry.replace([old.registration]);

      const stale = await registry.clients()[old.registration.id]!.createSession({
        provider: old.registration.id,
        cwd: "/workspace",
      });
      const persistence = stale.describePersistence();
      expect(persistence).not.toBeNull();

      registry.replace([next.registration]);
      await old.waitForClose();
      expect(old.closeCount()).toBe(1);

      await expect(stale.close()).resolves.toBeUndefined();

      const replacement = registry.clients()[next.registration.id];
      expect(replacement).toBeDefined();
      const resumed = await replacement!.resumeSession(persistence!, {
        cwd: "/workspace",
      });

      await expect(
        resumed.startTurn("after reload", { clientMessageId: "after-reload" }),
      ).resolves.toEqual({ turnId: "turn-1" });

      expect(next.inputs).toContainEqual(
        expect.objectContaining({
          type: "session.open",
          history: "replay",
          persistence: {
            version: 1,
            data: { token: "root" },
          },
        }),
      );

      await resumed.close();
    } finally {
      await registry.shutdown();
    }
  });

  test("prompting a stale session raises StaleProviderSessionError", async () => {
    const old = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());

    try {
      registry.replace([old.registration]);
      const stale = await registry.clients()[old.registration.id]!.createSession({
        provider: old.registration.id,
        cwd: "/workspace",
      });

      registry.replace([]);
      await old.waitForClose();
      expect(old.closeCount()).toBe(1);

      const failure = await stale
        .startTurn("after reload", { clientMessageId: "after-reload" })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(StaleProviderSessionError);
      expect(isStaleProviderSessionError(failure)).toBe(true);
      expect(isStaleProviderSessionError(new Error("Provider connection is closed"))).toBe(false);
      expect(isStaleProviderSessionError(new Error("boom"))).toBe(false);
    } finally {
      await registry.shutdown();
    }
  });

  test("adapts callback providers into the existing AgentClient and AgentSession path", async () => {
    const harness = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id];
    expect(client).toBeDefined();

    await expect(client!.fetchCatalog({ scope: "global", force: false })).resolves.toMatchObject({
      models: [
        {
          provider: "plugin-direct",
          id: "plugin-model",
          isDefault: true,
          thinkingOptions: [{ id: "deep", label: "Deep" }],
          defaultThinkingOptionId: "deep",
        },
      ],
      modes: [{ id: "build" }],
      defaultModeId: "build",
    });

    const session = await client!.createSession({ provider: "plugin-direct", cwd: "/workspace" });
    expect(session.features).toEqual([
      expect.objectContaining({
        type: "select",
        id: "voice",
        options: [{ id: "direct", label: "Direct", value: "direct" }],
      }),
    ]);
    expect(session.describePersistence()).toMatchObject({
      provider: "plugin-direct",
      metadata: { pluginProviderPersistence: { version: 1, data: { token: "root" } } },
    });

    const history: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) history.push(event);
    expect(history).toContainEqual(
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({ type: "timeline", id: "child-1" }),
      }),
    );
    expect(history).toContainEqual(
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({ type: "upsert", id: "child-1", status: "completed" }),
      }),
    );

    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    await expect(
      session.startTurn("hello", { clientMessageId: "client-message" }),
    ).resolves.toEqual({ turnId: "turn-1" });
    expect(
      events
        .filter((event) => event.type === "timeline")
        .map((event) => (event.type === "timeline" ? event.item : null)),
    ).toEqual([
      { type: "assistant_message", text: "Hel", messageId: "answer" },
      { type: "assistant_message", text: "lo", messageId: "answer" },
    ]);
    expect(session.getPendingPermissions()).toEqual([
      expect.objectContaining({ id: "permission-1", provider: "plugin-direct" }),
    ]);

    await session.respondToPermission("permission-1", { behavior: "allow" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "permission_resolved",
        requestId: "permission-1",
        resolution: { behavior: "allow" },
      }),
    );
    await session.setModel?.("plugin-model");
    expect(await session.getRuntimeInfo()).toMatchObject({
      model: "plugin-model",
      modeId: "build",
    });

    unsubscribe();
    await session.close();
    registry.replace([]);
    await expect.poll(harness.closeCount).toBe(1);
    expect(harness.inputs.map((input) => input.type)).toContain("session.close");
  });
});

type RequestKind = "session.open" | "catalog" | "session.configure" | "session.prompt";

async function requestFromClient(client: AgentClient, kind: RequestKind): Promise<unknown> {
  if (kind === "catalog") return client.fetchCatalog({ scope: "global" });
  const session = await client.createSession({ provider: client.provider, cwd: "/workspace" });
  if (kind === "session.open") return session;
  if (kind === "session.configure") return session.setMode("build");
  return session.startTurn("hello", { clientMessageId: "pending-message" });
}

async function withObservedProvider(
  options: ProviderHarnessOptions,
  run: (client: AgentClient, registry: PluginAgentClientRegistry) => Promise<void>,
): Promise<void> {
  const harness = createProviderHarness(options);
  const registry = new PluginAgentClientRegistry(createTestLogger());
  const unhandled: unknown[] = [];
  const observe = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", observe);
  registry.replace([harness.registration]);
  try {
    await run(registry.clients()[harness.registration.id]!, registry);
    await registry.shutdown();
    await nextTurn();
    expect(unhandled).toEqual([]);
  } finally {
    await registry.shutdown();
    process.off("unhandledRejection", observe);
  }
}

describe("pending provider responses", () => {
  test.each<RequestKind>(["session.open", "catalog", "session.configure", "session.prompt"])(
    "preserves the send error for %s",
    async (kind) => {
      const failure = new Error("Provider send failed");
      await withObservedProvider(
        {
          async handleInput(input) {
            if (input.type === kind) throw failure;
            return false;
          },
        },
        async (client) => {
          await expect(requestFromClient(client, kind)).rejects.toBe(failure);
        },
      );
    },
  );

  test.each([
    [
      "catalog",
      expect.objectContaining({
        models: [expect.objectContaining({ id: "plugin-model", isDefault: true })],
        defaultModeId: "build",
      }),
    ],
    ["session.configure", undefined],
  ] as const)(
    "contains an early request.failed for %s and permits a successful retry",
    async (kind, result) => {
      let failed = false;
      await withObservedProvider(
        {
          async handleInput(input, emit) {
            if (input.type !== kind || !("requestId" in input) || failed) return false;
            failed = true;
            emit({
              type: "request.failed",
              requestId: input.requestId,
              error: { message: "Provider request failed", code: "busy", diagnostic: "retry" },
            });
            await nextTurn();
            return true;
          },
        },
        async (client) => {
          await expect(requestFromClient(client, kind)).rejects.toMatchObject({
            message: "Provider request failed",
            code: "busy",
            diagnostic: "retry",
          });
          await expect(requestFromClient(client, kind)).resolves.toEqual(result);
        },
      );
    },
  );

  test.each([
    ["session.open", "Provider session closed"],
    ["session.configure", "Provider session closed"],
    ["session.prompt", StaleProviderSessionError],
  ] as const)("contains session closure while accepting %s", async (kind, error) => {
    await withObservedProvider(
      {
        async handleInput(input, emit) {
          if (input.type !== kind || !("sessionId" in input)) return false;
          emit({
            type: "session.closed",
            sessionId: input.sessionId,
            error: { message: "Provider session closed" },
          });
          await nextTurn();
          return true;
        },
      },
      async (client) => {
        await expect(requestFromClient(client, kind)).rejects.toThrow(error);
      },
    );
  });

  test.each([
    ["session.open", "Provider connection closed"],
    ["catalog", "Provider closed"],
    ["session.configure", "Provider closed"],
    ["session.prompt", StaleProviderSessionError],
  ] as const)("contains connection shutdown while accepting %s", async (kind, error) => {
    let disconnect!: () => Promise<void>;
    await withObservedProvider(
      {
        async handleInput(input) {
          if (input.type !== kind) return false;
          await disconnect();
          await nextTurn();
          return true;
        },
      },
      async (client, registry) => {
        disconnect = () => registry.shutdown();
        await expect(requestFromClient(client, kind)).rejects.toThrow(error);
      },
    );
  });

  test.each([true, false])(
    "preserves cancellation with acceptance pending: %s",
    async (pending) => {
      const controller = new AbortController();
      const reason = new Error("Catalog refresh cancelled");
      await withObservedProvider(
        {
          async handleInput(input) {
            if (input.type !== "catalog") return false;
            if (pending) {
              controller.abort(reason);
              await nextTurn();
            } else {
              setImmediate(() => controller.abort(reason));
            }
            return true;
          },
        },
        async (client) => {
          await expect(
            client.fetchCatalog({ scope: "global" }, { signal: controller.signal }),
          ).rejects.toBe(reason);
        },
      );
    },
  );
});
