import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
  ProviderTimelineItem,
  ProviderSessionSummary,
} from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "./agent-sdk-types.js";
import { configureExternalProviderDefinitions } from "./provider-registry.js";
import { AgentManager } from "./agent-manager.js";
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

function isCoreImport(input: Extract<ProviderInput, { type: "session.open" }>): boolean {
  return (
    input.persistence?.version === 0 &&
    typeof input.persistence.data === "object" &&
    input.persistence.data !== null &&
    !Array.isArray(input.persistence.data) &&
    input.persistence.data.kind === "import"
  );
}

interface ProviderHarnessOptions {
  capabilities?: ProviderConnection["capabilities"];
  completeTurn?: boolean;
  rewindItems?: readonly ProviderTimelineItem[];
  nestedChild?: boolean;
  sessionSummaries?: readonly ProviderSessionSummary[];
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
      if (input.type === "sessions") {
        emit({
          type: "sessions",
          requestId: input.requestId,
          sessions: [...(options.sessionSummaries ?? [])],
        });
        return;
      }
      if (input.type === "session.open") {
        const coreImport = isCoreImport(input);
        emit({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities,
          restoration: "core",
          persistence: coreImport
            ? { version: 1, data: { sessionId: "native-import-id" } }
            : (input.persistence ?? { version: 1, data: { token: "root" } }),
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
        if (options.nestedChild) {
          emit({
            type: "session.opened",
            sessionId: "grandchild-1",
            parentSessionId: "child-1",
            capabilities: [],
            restoration: "parent",
            title: "Plugin grandchild",
            cwd: input.config.cwd,
          });
          emit({ type: "session.ready", sessionId: "grandchild-1" });
        }
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
      if (input.type === "session.revert") {
        for (const item of options.rewindItems ?? []) {
          emit({ type: "timeline.item", sessionId: input.sessionId, item });
        }
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
    inputs,
    closeCount: () => closeCount,
    waitForClose: () => closed,
    emit,
  };
}

function eventsOfType(events: AgentStreamEvent[], type: AgentStreamEvent["type"]) {
  return events.filter((event) => event.type === type);
}

describe("PluginAgentClientRegistry", () => {
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
  test("replaces accumulated history with one active branch replay", async () => {
    const retained = [
      {
        type: "user_message" as const,
        id: "user-1",
        messageId: "user-1",
        text: "first",
        revertToken: "token-1",
      },
      {
        type: "assistant_message" as const,
        id: "assistant-1",
        messageId: "assistant-1",
        text: "first reply",
      },
    ];
    const harness = createProviderHarness({
      capabilities: ["session.revert.conversation"],
      rewindItems: retained,
    });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id];
    if (!client) throw new Error("Missing plugin provider client");
    const session = await client.createSession({
      provider: harness.registration.id,
      cwd: "/workspace",
    });
    const openInput = harness.inputs.find(
      (input): input is Extract<ProviderInput, { type: "session.open" }> =>
        input.type === "session.open",
    );
    if (!openInput) throw new Error("Missing plugin provider open request");
    harness.emit({
      type: "timeline.item",
      sessionId: openInput.sessionId,
      item: retained[0],
    });
    harness.emit({
      type: "timeline.item",
      sessionId: openInput.sessionId,
      item: retained[1],
    });
    harness.emit({
      type: "timeline.item",
      sessionId: openInput.sessionId,
      item: {
        type: "user_message",
        id: "user-2",
        messageId: "user-2",
        text: "second",
        revertToken: "token-2",
      },
    });
    harness.emit({
      type: "timeline.item",
      sessionId: openInput.sessionId,
      item: {
        type: "assistant_message",
        id: "assistant-2",
        messageId: "assistant-2",
        text: "second reply",
      },
    });

    await session.revertConversation?.({ messageId: "user-2" });
    const history: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) history.push(event);
    expect(
      history.flatMap((event) =>
        event.type === "timeline" &&
        (event.item.type === "user_message" || event.item.type === "assistant_message")
          ? [event.item.text]
          : [],
      ),
    ).toEqual(["first", "first reply"]);
    expect(harness.inputs).toContainEqual(
      expect.objectContaining({ type: "session.revert", token: "token-2", scope: "conversation" }),
    );
    await session.close();
    await registry.shutdown();
  });

  test("preserves direct provider ancestry for nested subagents", async () => {
    const harness = createProviderHarness({ nestedChild: true });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id];
    if (!client) throw new Error("Missing plugin provider client");
    const session = await client.createSession({
      provider: harness.registration.id,
      cwd: "/workspace",
    });

    const history: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) history.push(event);
    const upserts = history.flatMap((event) =>
      event.type === "provider_subagent" && event.event.type === "upsert" ? [event.event] : [],
    );
    expect(upserts).toContainEqual(
      expect.objectContaining({ id: "child-1", parentSubagentId: null }),
    );
    expect(upserts).toContainEqual(
      expect.objectContaining({ id: "grandchild-1", parentSubagentId: "child-1" }),
    );

    await session.close();
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

describe("plugin provider configuration", () => {
  test("normalizes options once and carries the exact value through discovery and launch", async () => {
    const harness = createProviderHarness();
    const observed: unknown[] = [];
    let normalizations = 0;
    const registration: ProviderRegistration = {
      ...harness.registration,
      providerOptionsSchema: z
        .object({ token: z.string().default("default") })
        .strict()
        .transform(({ token }) => {
          normalizations += 1;
          return { token: `${token}!` };
        }),
      async checkAvailability(options) {
        observed.push({ availability: options });
        return { status: "available", diagnostic: "OMP is ready" };
      },
      async getCatalogCacheKey(options) {
        observed.push({ cacheKey: options });
        return JSON.stringify(options.providerOptions);
      },
    };
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([registration]);
    const definition = registry.definitions()[registration.id]!;
    const client = registry.clients()[registration.id]!;
    const providerOptions = await definition.validateOptions({ token: "session" });
    const config = definition.applyOptions(
      { provider: registration.id, cwd: "/workspace" },
      providerOptions,
    );
    const catalogOptions = {
      scope: "workspace" as const,
      cwd: "/workspace",
      force: false,
      providerOptions: config.providerOptions,
      settings: { approval: "ask" },
    };

    await client.checkAvailability?.(catalogOptions);
    await expect(client.getCatalogCacheKey?.(catalogOptions)).resolves.toBe('{"token":"session!"}');
    await definition.fetchCatalog(catalogOptions, client);
    const session = await client.createSession(config);

    expect(normalizations).toBe(1);
    expect(observed).toEqual([
      {
        availability: {
          scope: "workspace",
          cwd: "/workspace",
          force: false,
          providerOptions: { token: "session!" },
          settings: { approval: "ask" },
        },
      },
      {
        cacheKey: {
          scope: "workspace",
          cwd: "/workspace",
          force: false,
          providerOptions: { token: "session!" },
          settings: { approval: "ask" },
        },
      },
    ]);
    expect(harness.inputs).toContainEqual(
      expect.objectContaining({
        type: "catalog",
        providerOptions: { token: "session!" },
        settings: { approval: "ask" },
      }),
    );
    expect(harness.inputs).toContainEqual(
      expect.objectContaining({
        type: "session.open",
        config: expect.objectContaining({ providerOptions: { token: "session!" } }),
      }),
    );
    await expect(definition.validateOptions({ typo: true })).rejects.toThrow(
      "Invalid providerOptions",
    );

    await session.close();
    await registry.shutdown();
  });

  test("applies configured models, settings, denied tools, and derived plugin profiles", async () => {
    const harness = createProviderHarness();
    const cacheOptions: unknown[] = [];
    const registration: ProviderRegistration = {
      ...harness.registration,
      async getCatalogCacheKey(options) {
        cacheOptions.push(options);
        return "profile";
      },
    };
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([registration]);
    const definitions = configureExternalProviderDefinitions(registry.definitions(), {
      "plugin-work": {
        extends: registration.id,
        label: "Plugin work",
        models: [{ id: "configured", label: "Configured" }],
        additionalModels: [{ id: "extra", label: "Extra", isDefault: true }],
        providerOptions: { command: ["omp-work"] },
        settings: { approval: "ask" },
        disallowedTools: ["shell", "shell", "web_search"],
      },
    });
    const definition = definitions["plugin-work"]!;
    const client = definition.createClient(createTestLogger());
    const catalogOptions = await definition.normalizeCatalogOptions?.({
      scope: "workspace",
      cwd: "/workspace",
      force: false,
    });
    if (!catalogOptions) throw new Error("Missing normalized catalog options");
    const catalog = await definition.fetchCatalog(catalogOptions, client);
    await client.getCatalogCacheKey?.(catalogOptions);
    const providerOptions = await definition.validateOptions({ timeoutMs: 45_000 });
    const config = definition.applyOptions(
      { provider: "plugin-work", cwd: "/workspace", featureValues: { local: true } },
      providerOptions,
    );

    expect(catalog.models).toEqual([
      expect.objectContaining({ id: "configured", provider: "plugin-work", isDefault: false }),
      expect.objectContaining({ id: "extra", provider: "plugin-work", isDefault: true }),
    ]);
    expect(config).toMatchObject({
      providerOptions: { command: ["omp-work"], timeoutMs: 45_000 },
      featureValues: { approval: "ask", local: true },
      deniedTools: ["shell", "web_search"],
    });
    expect(harness.inputs).toContainEqual(
      expect.objectContaining({
        type: "catalog",
        providerOptions: { command: ["omp-work"] },
        settings: { approval: "ask" },
      }),
    );
    expect(cacheOptions).toEqual([
      {
        scope: "workspace",
        cwd: "/workspace",
        force: false,
        providerOptions: { command: ["omp-work"] },
        settings: { approval: "ask" },
      },
    ]);
    await registry.shutdown();
  });

  test("updates ordinary plugin persistence across resume and archive", async () => {
    const harness = createProviderHarness({ capabilities: [...CAPABILITIES, "session.archive"] });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id]!;
    const initial = {
      provider: harness.registration.id,
      sessionId: 'plugin:{"version":1,"data":{"token":"initial"}}',
      metadata: { pluginProviderPersistence: { version: 1, data: { token: "initial" } } },
    };
    const session = await client.resumeSession(initial, { cwd: "/workspace" });
    const opened = harness.inputs.findLast(
      (input): input is Extract<ProviderInput, { type: "session.open" }> =>
        input.type === "session.open",
    );
    if (!opened) throw new Error("Missing resumed plugin session");
    harness.emit({
      type: "session.persistence",
      sessionId: opened.sessionId,
      persistence: { version: 1, data: { token: "updated" } },
    });
    const updated = session.describePersistence();
    expect(updated).toEqual({
      provider: harness.registration.id,
      sessionId: 'plugin:{"version":1,"data":{"token":"updated"}}',
      metadata: { pluginProviderPersistence: { version: 1, data: { token: "updated" } } },
    });

    await session.close();
    const resumed = await client.resumeSession(updated!, { cwd: "/workspace" });
    expect(harness.inputs).toContainEqual(
      expect.objectContaining({
        type: "session.open",
        persistence: { version: 1, data: { token: "updated" } },
      }),
    );
    await client.archiveNativeSession!(updated!);
    expect(harness.inputs).toContainEqual(
      expect.objectContaining({
        type: "session.archive",
        persistence: { version: 1, data: { token: "updated" } },
      }),
    );

    await resumed.close();
    await registry.shutdown();
  });

  test("resumes stored OMP agents through the registered plugin", async () => {
    const harness = createProviderHarness();
    const registration: ProviderRegistration = { ...harness.registration, id: "omp" };
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([registration]);
    const legacyHandle = {
      provider: "omp",
      sessionId: "legacy-native-id",
      nativeHandle: "/home/user/.omp/agent/sessions/legacy.jsonl",
      metadata: { cwd: process.cwd(), model: "openai/gpt-5" },
    };
    const manager = new AgentManager({
      clients: { omp: registry.clients().omp! },
      providerDefinitions: { omp: registry.definitions().omp! },
      idFactory: () => "00000000-0000-4000-8000-000000000014",
      logger: createTestLogger(),
    });

    const resumed = await manager.resumeAgentFromPersistence(legacyHandle);
    expect(resumed.provider).toBe("omp");
    expect(resumed.persistence).toEqual(legacyHandle);
    expect(harness.inputs).toContainEqual(
      expect.objectContaining({
        type: "session.open",
        history: "replay",
        persistence: {
          version: 0,
          data: {
            source: "paseo-core",
            kind: "resume",
            sessionId: "legacy-native-id",
            nativeHandle: "/home/user/.omp/agent/sessions/legacy.jsonl",
            metadata: { cwd: process.cwd(), model: "openai/gpt-5" },
          },
        },
      }),
    );

    await manager.closeAgent(resumed.id);
    await registry.shutdown();
  });

  test("imports legacy OMP sessions without rewriting rollback handles", async () => {
    const harness = createProviderHarness({ capabilities: [...CAPABILITIES, "session.archive"] });
    const registration: ProviderRegistration = { ...harness.registration, id: "omp" };
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([registration]);
    const client = registry.clients().omp!;
    const imported = await client.importSession!(
      {
        providerHandleId: "/home/user/.omp/agent/sessions/import.jsonl",
        cwd: "/workspace",
      },
      {
        config: { provider: "omp", cwd: "/workspace" },
        storedConfig: { provider: "omp", cwd: "/workspace" },
      },
    );
    expect(harness.inputs).toContainEqual(
      expect.objectContaining({
        type: "session.open",
        persistence: {
          version: 0,
          data: {
            source: "paseo-core",
            kind: "import",
            providerHandleId: "/home/user/.omp/agent/sessions/import.jsonl",
          },
        },
      }),
    );
    const importOpen = harness.inputs.findLast(
      (input): input is Extract<ProviderInput, { type: "session.open" }> =>
        input.type === "session.open",
    );
    if (!importOpen) throw new Error("Missing legacy import session");
    harness.emit({
      type: "session.persistence",
      sessionId: importOpen.sessionId,
      persistence: { version: 1, data: { sessionId: "native-import-id-2" } },
    });
    const updatedImport = imported.session.describePersistence();
    expect(updatedImport).toEqual({
      provider: "omp",
      sessionId: "native-import-id-2",
      nativeHandle: "/home/user/.omp/agent/sessions/import.jsonl",
      metadata: {
        cwd: "/workspace",
        pluginProviderPersistence: { version: 1, data: { sessionId: "native-import-id-2" } },
      },
    });

    await imported.session.close();
    const resumedImport = await client.resumeSession(updatedImport!, { cwd: "/workspace" });
    expect(harness.inputs).toContainEqual(
      expect.objectContaining({
        type: "session.open",
        persistence: { version: 1, data: { sessionId: "native-import-id-2" } },
      }),
    );
    expect(resumedImport.describePersistence()).toEqual(updatedImport);
    await client.archiveNativeSession!(updatedImport!);
    expect(harness.inputs).toContainEqual(
      expect.objectContaining({
        type: "session.archive",
        persistence: { version: 1, data: { sessionId: "native-import-id-2" } },
      }),
    );
    const pluginNative = await client.importSession!(
      {
        providerHandleId: 'plugin:{"version":1,"data":{"token":"native"}}',
        cwd: "/workspace",
      },
      {
        config: { provider: "omp", cwd: "/workspace" },
        storedConfig: { provider: "omp", cwd: "/workspace" },
      },
    );
    expect(pluginNative.persistence).toMatchObject({
      provider: "omp",
      sessionId: 'plugin:{"version":1,"data":{"token":"native"}}',
      metadata: { pluginProviderPersistence: { version: 1, data: { token: "native" } } },
    });

    await resumedImport.close();
    await pluginNative.session.close();
    await registry.shutdown();
  });

  test("reflects capabilities negotiated after a configured wrapper connects", async () => {
    const harness = createProviderHarness({ capabilities: ["session.list"] });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const definitions = configureExternalProviderDefinitions(registry.definitions(), {
      "plugin-profile": {
        extends: harness.registration.id,
        label: "Plugin profile",
      },
    });
    const client = definitions["plugin-profile"]!.createClient(createTestLogger());

    expect(client.capabilities.supportsSessionListing).toBe(false);
    await client.fetchCatalog({ scope: "workspace", cwd: "/workspace", force: false });
    expect(client.capabilities.supportsSessionListing).toBe(true);
    await expect(client.listImportableSessions?.({ cwd: "/workspace" })).resolves.toEqual([]);

    await registry.shutdown();
  });

  test("forwards bounded denied tools and separate prompt previews", async () => {
    const harness = createProviderHarness({
      capabilities: [...CAPABILITIES, "session.list"],
      sessionSummaries: [
        {
          persistence: { version: 1, data: { token: "listed" } },
          cwd: "/workspace",
          title: "Listed session",
          description: "provider description",
          firstPromptPreview: "first prompt",
          lastPromptPreview: "last prompt",
          updatedAt: "2026-09-11T12:00:00.000Z",
        },
      ],
    });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id]!;
    const session = await client.createSession({
      provider: harness.registration.id,
      cwd: "/workspace",
      deniedTools: [" shell ", "shell", "web_search"],
    });

    expect(harness.inputs).toContainEqual(
      expect.objectContaining({
        type: "session.open",
        config: expect.objectContaining({ deniedTools: ["shell", "web_search"] }),
      }),
    );
    await expect(client.listImportableSessions?.({ cwd: "/workspace" })).resolves.toEqual([
      {
        providerHandleId: 'plugin:{"version":1,"data":{"token":"listed"}}',
        cwd: "/workspace",
        title: "Listed session",
        firstPromptPreview: "first prompt",
        lastPromptPreview: "last prompt",
        lastActivityAt: new Date("2026-09-11T12:00:00.000Z"),
      },
    ]);

    await session.close();
    await registry.shutdown();
  });
});
