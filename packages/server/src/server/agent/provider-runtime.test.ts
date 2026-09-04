import type {
  ProviderConnectRequest,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
  ProviderSessionConfig,
} from "@getpaseo/plugin/provider";
import { describe, expect, it } from "vitest";
import { ProviderRuntime } from "./provider-connection-runtime.js";

const baseConfig: ProviderSessionConfig = {
  cwd: "/repo",
  env: {},
  mcpServers: {},
  settings: {},
  persist: true,
};

function controlledProvider(options: {
  connectionCapabilities: readonly string[];
  receive(input: ProviderInput, emit: (event: ProviderEvent) => void): void;
}): { registration: ProviderRegistration; inputs: ProviderInput[] } {
  const inputs: ProviderInput[] = [];
  const registration: ProviderRegistration = {
    id: "controlled",
    label: "Controlled",
    async connect(_request: ProviderConnectRequest) {
      const listeners = new Set<(event: ProviderEvent) => void>();
      const emit = (event: ProviderEvent) => {
        for (const listener of listeners) listener(event);
      };
      return {
        version: 1,
        capabilities: options.connectionCapabilities,
        async send(input) {
          inputs.push(input);
          options.receive(input, emit);
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {},
      };
    },
  };
  return { registration, inputs };
}

function openEvents(
  input: Extract<ProviderInput, { type: "session.open" }>,
  emit: (event: ProviderEvent) => void,
  capabilities: readonly string[],
): void {
  emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities,
    restoration: "core",
    cwd: input.config.cwd,
  });
  emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
}

describe("ProviderRuntime", () => {
  it("closes a delayed connection that resolves after the runtime is closed", async () => {
    let resolveConnection!: (
      connection: Awaited<ReturnType<ProviderRegistration["connect"]>>,
    ) => void;
    let connectCount = 0;
    let closeCount = 0;
    const registration: ProviderRegistration = {
      id: "delayed",
      label: "Delayed",
      connect() {
        connectCount += 1;
        return new Promise((resolve) => {
          resolveConnection = resolve;
        });
      },
    };
    const runtime = new ProviderRuntime(registration);
    const availability = runtime.isAvailable();
    await expect.poll(() => connectCount).toBe(1);

    const closing = runtime.close();
    resolveConnection({
      version: 1,
      capabilities: [],
      async send() {},
      onEvent() {
        return () => undefined;
      },
      async close() {
        closeCount += 1;
      },
    });

    await expect(availability).rejects.toThrow("Provider runtime is closed");
    await closing;
    expect(closeCount).toBe(1);
    await expect(runtime.catalog()).rejects.toThrow("Provider runtime is closed");
    expect(connectCount).toBe(1);
  });

  it("ignores unknown and duplicate capability IDs during negotiation", async () => {
    const controlled = controlledProvider({
      connectionCapabilities: ["future.capability", "prompt.message", "prompt.message"],
      receive(input, emit) {
        if (input.type === "session.open") {
          openEvents(input, emit, ["future.session.capability", "prompt.message"]);
        }
      },
    });
    const runtime = new ProviderRuntime(controlled.registration);
    const session = await runtime.openSession({
      sessionId: "session-1",
      config: baseConfig,
      history: "skip",
    });

    expect(session.negotiatedCapabilities).toEqual(["prompt.message"]);
    await runtime.close();
  });

  it("refuses unsupported steer and tool policy before crossing the boundary", async () => {
    const controlled = controlledProvider({
      connectionCapabilities: ["prompt.message"],
      receive(input, emit) {
        if (input.type === "session.open") openEvents(input, emit, ["prompt.message"]);
      },
    });
    const runtime = new ProviderRuntime(controlled.registration);
    const session = await runtime.openSession({
      sessionId: "session-1",
      config: baseConfig,
      history: "skip",
    });

    await expect(
      session.prompt({
        clientMessageId: "steer-1",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "redirect" }] },
      }),
    ).rejects.toThrow("prompt.steer");
    expect(controlled.inputs).toHaveLength(1);

    await expect(
      runtime.openSession({
        sessionId: "session-2",
        config: { ...baseConfig, toolPolicy: { preapproved: [] } },
        history: "skip",
      }),
    ).rejects.toThrow("permission.tool_policy");
    expect(controlled.inputs).toHaveLength(1);
    await runtime.close();
  });

  it("refuses every unnegotiated prompt extension and persisted open before sending", async () => {
    const controlled = controlledProvider({
      connectionCapabilities: ["prompt.message"],
      receive(input, emit) {
        if (input.type === "session.open") openEvents(input, emit, ["prompt.message"]);
      },
    });
    const runtime = new ProviderRuntime(controlled.registration);

    await expect(
      runtime.openSession({
        sessionId: "persisted",
        config: baseConfig,
        persistence: { version: 1, data: { nativeId: "one" } },
        history: "replay",
      }),
    ).rejects.toThrow("session.persistence");
    expect(controlled.inputs).toEqual([]);

    const session = await runtime.openSession({
      sessionId: "fresh",
      config: baseConfig,
      history: "skip",
    });
    const unsupportedPrompts = [
      {
        clientMessageId: "image",
        delivery: "auto" as const,
        input: {
          type: "message" as const,
          content: [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }],
        },
      },
      {
        clientMessageId: "schema",
        delivery: "auto" as const,
        input: { type: "message" as const, content: [{ type: "text" as const, text: "hello" }] },
        outputSchema: { type: "object" },
      },
      {
        clientMessageId: "thinking",
        delivery: "auto" as const,
        input: { type: "message" as const, content: [{ type: "text" as const, text: "hello" }] },
        maxThinkingTokens: 100,
      },
    ];
    for (const prompt of unsupportedPrompts) {
      await expect(session.prompt(prompt)).rejects.toThrow("Provider does not support");
    }
    expect(controlled.inputs.map((input) => input.type)).toEqual(["session.open"]);
    await runtime.close();
  });

  it("quarantines reload events and preserves identity and old config on failure", async () => {
    let reloadShouldFail = true;
    const controlled = controlledProvider({
      connectionCapabilities: ["prompt.message", "prompt.command", "session.reload"],
      receive(input, emit) {
        if (input.type === "session.open") {
          openEvents(input, emit, ["prompt.message", "session.reload"]);
          return;
        }
        if (input.type !== "session.reload") return;
        emit({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities: ["prompt.message", "prompt.command", "session.reload"],
          restoration: "core",
          persistence: { version: 1, data: { model: input.config.model ?? null } },
          cwd: input.config.cwd,
        });
        emit({
          type: "session.config",
          sessionId: input.sessionId,
          config: {
            model: input.config.model,
            models: [],
            modes: [],
            thinkingOptions: [],
            settings: [],
          },
        });
        if (reloadShouldFail) {
          emit({
            type: "request.failed",
            requestId: input.requestId,
            error: { message: "candidate failed" },
          });
        } else {
          emit({
            type: "session.ready",
            requestId: input.requestId,
            sessionId: input.sessionId,
          });
        }
      },
    });
    const runtime = new ProviderRuntime(controlled.registration);
    const session = await runtime.openSession({
      sessionId: "stable-id",
      config: { ...baseConfig, model: "old" },
      history: "skip",
    });
    const published: ProviderEvent[] = [];
    session.onEvent((event) => published.push(event));

    await expect(session.reload({ ...baseConfig, model: "broken" })).rejects.toThrow(
      "candidate failed",
    );
    expect(session.id).toBe("stable-id");
    expect(session.sessionConfig.model).toBe("old");
    expect(session.negotiatedCapabilities).toEqual(["prompt.message", "session.reload"]);
    expect(published).toEqual([]);

    reloadShouldFail = false;
    await session.reload({ ...baseConfig, model: "new" });
    expect(session.id).toBe("stable-id");
    expect(session.sessionConfig.model).toBe("new");
    expect(session.negotiatedCapabilities).toEqual([
      "prompt.message",
      "prompt.command",
      "session.reload",
    ]);
    expect(session.persistence).toEqual({ version: 1, data: { model: "new" } });
    expect(published.some((event) => event.type === "session.opened")).toBe(false);
    expect(published).toContainEqual(
      expect.objectContaining({
        type: "session.config",
        config: expect.objectContaining({ model: "new" }),
      }),
    );
    await runtime.close();
  });

  it("continues publishing active-generation events while a reload candidate is preparing", async () => {
    const controlled = controlledProvider({
      connectionCapabilities: ["prompt.message", "session.reload"],
      receive(input, emit) {
        if (input.type === "session.open") {
          openEvents(input, emit, ["prompt.message", "session.reload"]);
          return;
        }
        if (input.type !== "session.reload") return;
        emit({
          type: "timeline.item",
          sessionId: input.sessionId,
          item: { type: "assistant_message", id: "old-live", text: "old runtime remains live" },
        });
        emit({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities: ["prompt.message", "session.reload"],
          restoration: "core",
          cwd: input.config.cwd,
        });
        emit({
          type: "timeline.item",
          sessionId: input.sessionId,
          item: { type: "assistant_message", id: "candidate", text: "candidate event" },
        });
        emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: "candidate failed" },
        });
      },
    });
    const runtime = new ProviderRuntime(controlled.registration);
    const session = await runtime.openSession({
      sessionId: "stable",
      config: baseConfig,
      history: "skip",
    });
    const published: ProviderEvent[] = [];
    session.onEvent((event) => published.push(event));

    await expect(session.reload({ ...baseConfig, model: "broken" })).rejects.toThrow(
      "candidate failed",
    );
    expect(published).toEqual([
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ id: "old-live" }),
      }),
    ]);
    expect(session.history).not.toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ id: "candidate" }),
      }),
    );
    await runtime.close();
  });

  it("discards candidate descendants when their parent reload fails", async () => {
    const controlled = controlledProvider({
      connectionCapabilities: ["prompt.message", "session.reload", "session.subsession"],
      receive(input, emit) {
        if (input.type === "session.open") {
          openEvents(input, emit, ["prompt.message", "session.reload", "session.subsession"]);
          return;
        }
        if (input.type !== "session.reload") return;
        emit({
          type: "session.opened",
          sessionId: "candidate-child",
          parentSessionId: input.sessionId,
          capabilities: ["prompt.message", "session.subsession"],
          restoration: "parent",
          cwd: input.config.cwd,
        });
        emit({
          type: "timeline.item",
          sessionId: "candidate-child",
          item: { type: "assistant_message", id: "candidate-child-item", text: "hidden" },
        });
        emit({
          type: "session.opened",
          sessionId: "candidate-grandchild",
          parentSessionId: "candidate-child",
          capabilities: ["prompt.message"],
          restoration: "parent",
          cwd: input.config.cwd,
        });
        emit({
          type: "timeline.item",
          sessionId: "candidate-grandchild",
          item: { type: "assistant_message", id: "grandchild-item", text: "also hidden" },
        });
        emit({ type: "session.closed", sessionId: "candidate-grandchild" });
        emit({ type: "session.closed", sessionId: "candidate-child" });
        emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: "candidate failed" },
        });
      },
    });
    const runtime = new ProviderRuntime(controlled.registration);
    const openedChildren: ProviderEvent[] = [];
    runtime.onSessionOpened((_session, event) => openedChildren.push(event));
    const session = await runtime.openSession({
      sessionId: "stable",
      config: baseConfig,
      history: "skip",
    });

    await expect(session.reload({ ...baseConfig, model: "broken" })).rejects.toThrow(
      "candidate failed",
    );

    expect(openedChildren).toEqual([]);
    expect(session.history).toEqual([]);
    await runtime.close();
  });

  it("discards child sessions emitted before a failed initial root open", async () => {
    const controlled = controlledProvider({
      connectionCapabilities: ["prompt.message", "session.subsession"],
      receive(input, emit) {
        if (input.type !== "session.open") return;
        emit({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities: ["prompt.message", "session.subsession"],
          restoration: "core",
          cwd: input.config.cwd,
        });
        emit({
          type: "session.opened",
          sessionId: "orphan-child",
          parentSessionId: input.sessionId,
          capabilities: [],
          restoration: "parent",
          cwd: input.config.cwd,
        });
        emit({
          type: "timeline.item",
          sessionId: "orphan-child",
          item: { type: "assistant_message", id: "orphan-item", text: "must stay hidden" },
        });
        emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: "root open failed" },
        });
      },
    });
    const runtime = new ProviderRuntime(controlled.registration);
    const openedChildren: ProviderEvent[] = [];
    runtime.onSessionOpened((_session, event) => openedChildren.push(event));

    await expect(
      runtime.openSession({ sessionId: "root", config: baseConfig, history: "skip" }),
    ).rejects.toThrow("root open failed");

    expect(openedChildren).toEqual([]);
    await runtime.close();
  });

  it("enforces JSON-only in-process boundary messages and strips unknown nested fields", async () => {
    let emitFromProvider!: (event: ProviderEvent) => void;
    const receivedInputs: ProviderInput[] = [];
    const registration: ProviderRegistration = {
      id: "json-boundary",
      label: "JSON boundary",
      async connect() {
        const listeners = new Set<(event: ProviderEvent) => void>();
        emitFromProvider = (event) => {
          for (const listener of listeners) listener(event);
        };
        return {
          version: 1,
          capabilities: ["prompt.message"],
          async send(input) {
            receivedInputs.push(input);
            if (input.type === "session.open")
              openEvents(input, emitFromProvider, ["prompt.message"]);
          },
          onEvent(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async close() {},
        };
      },
    };
    const runtime = new ProviderRuntime(registration);
    const session = await runtime.openSession({
      sessionId: "root",
      config: baseConfig,
      history: "skip",
    });

    emitFromProvider({
      type: "session.config",
      sessionId: "root",
      config: {
        models: [
          {
            id: "model",
            label: "Model",
            metadata: { nested: { safe: true } },
            ignored: "strip me",
          },
        ],
        modes: [{ id: "mode", label: "Mode", ignored: "strip me too" }],
        thinkingOptions: [],
        settings: [],
        ignored: "strip config field",
      },
      ignored: "strip event field",
    } as ProviderEvent);
    expect(session.config).toEqual({
      models: [{ id: "model", label: "Model", metadata: { nested: { safe: true } } }],
      modes: [{ id: "mode", label: "Mode" }],
      thinkingOptions: [],
      settings: [],
    });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const invalid of [() => undefined, 1n, cyclic]) {
      expect(() =>
        emitFromProvider({
          type: "session.config",
          sessionId: "root",
          config: {
            models: [{ id: "invalid", label: "Invalid", metadata: { invalid } }],
            modes: [],
            thinkingOptions: [],
            settings: [],
          },
        } as ProviderEvent),
      ).toThrow();
    }
    expect(session.config.models).toHaveLength(1);

    await expect(
      runtime.openSession({
        sessionId: "invalid-input",
        config: {
          ...baseConfig,
          providerOptions: { invalid: (() => undefined) as never },
        },
        history: "skip",
      }),
    ).rejects.toThrow();
    expect(receivedInputs).toHaveLength(1);
    await runtime.close();
  });

  it("refuses archive actions that were not negotiated without sending them", async () => {
    const controlled = controlledProvider({
      connectionCapabilities: ["prompt.message"],
      receive() {},
    });
    const runtime = new ProviderRuntime(controlled.registration);

    await expect(runtime.archive({ version: 1, data: { id: "native-1" } })).rejects.toThrow(
      "session.archive",
    );
    await expect(runtime.unarchive({ version: 1, data: { id: "native-1" } })).rejects.toThrow(
      "session.unarchive",
    );
    expect(controlled.inputs).toEqual([]);
    await runtime.close();
  });

  it("preserves root notices and terminal close events", async () => {
    const controlled = controlledProvider({
      connectionCapabilities: ["prompt.message"],
      receive(input, emit) {
        if (input.type !== "session.open") return;
        openEvents(input, emit, ["prompt.message"]);
        queueMicrotask(() => {
          emit({
            type: "session.notice",
            sessionId: input.sessionId,
            notice: { id: "notice-1", severity: "warning", title: "Heads up" },
          });
          emit({ type: "session.closed", sessionId: input.sessionId });
        });
      },
    });
    const runtime = new ProviderRuntime(controlled.registration);
    const session = await runtime.openSession({
      sessionId: "root",
      config: baseConfig,
      history: "skip",
    });

    await expect.poll(() => session.history.length).toBe(2);
    expect(session.history.map((event) => event.type)).toEqual([
      "session.notice",
      "session.closed",
    ]);
    await runtime.close();
  });

  it("fails admitted work when the provider runtime dies", async () => {
    const controlled = controlledProvider({
      connectionCapabilities: ["prompt.message"],
      receive(input, emit) {
        if (input.type === "session.open") {
          openEvents(input, emit, ["prompt.message"]);
          return;
        }
        if (input.type === "session.prompt") {
          queueMicrotask(() => {
            emit({
              type: "session.runtime_failed",
              sessionId: input.sessionId,
              error: { message: "provider process exited" },
            });
          });
        }
      },
    });
    const runtime = new ProviderRuntime(controlled.registration);
    const session = await runtime.openSession({
      sessionId: "root",
      config: baseConfig,
      history: "skip",
    });

    await expect(
      session.prompt({
        clientMessageId: "message-1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      }),
    ).rejects.toThrow("provider process exited");
    expect(session.history).toContainEqual(
      expect.objectContaining({ type: "session.runtime_failed" }),
    );
    await runtime.close();
  });

  it("fails admitted request/response operations when the session runtime dies", async () => {
    const controlled = controlledProvider({
      connectionCapabilities: ["prompt.message", "session.configure"],
      receive(input, emit) {
        if (input.type === "session.open") {
          openEvents(input, emit, ["prompt.message", "session.configure"]);
          return;
        }
        if (input.type === "session.configure") {
          emit({
            type: "session.runtime_failed",
            sessionId: input.sessionId,
            error: { message: "provider process exited during configuration" },
          });
        }
      },
    });
    const runtime = new ProviderRuntime(controlled.registration);
    const session = await runtime.openSession({
      sessionId: "root",
      config: baseConfig,
      history: "skip",
    });

    await expect(session.configure({ model: "new" })).rejects.toThrow(
      "provider process exited during configuration",
    );
    await runtime.close();
  });

  it("rejects pending session requests and completes close when session.closed arrives first", async () => {
    const controlled = controlledProvider({
      connectionCapabilities: ["prompt.message", "session.configure"],
      receive(input, emit) {
        if (input.type === "session.open") {
          openEvents(input, emit, ["prompt.message", "session.configure"]);
        } else if (input.type === "session.close") {
          emit({ type: "session.closed", sessionId: input.sessionId });
        }
      },
    });
    const runtime = new ProviderRuntime(controlled.registration);
    const session = await runtime.openSession({
      sessionId: "root",
      config: baseConfig,
      history: "skip",
    });
    let configureError: Error | null = null;
    let closeSettled = false;
    const configuring = session.configure({ model: "pending" }).catch((error: Error) => {
      configureError = error;
    });
    await expect.poll(() => controlled.inputs.at(-1)?.type).toBe("session.configure");
    const closing = session.close().then(() => {
      closeSettled = true;
      return undefined;
    });

    await expect
      .poll(() => ({ configureError: configureError?.message, closeSettled }))
      .toEqual({
        configureError: "Provider session root closed",
        closeSettled: true,
      });
    await Promise.all([configuring, closing]);
    await runtime.close();
  });
});
