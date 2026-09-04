import type {
  AgentClient,
  AgentPromptInput,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../../agent-sdk-types.js";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/provider";
import { describe, expect, it } from "vitest";
import { registerNativeProvider } from "./provider.js";

const capabilities = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsSessionConfigure: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
  supportsRewindFiles: true,
  supportsRewindBoth: true,
};

class Session implements AgentSession {
  readonly provider = "native-test";
  readonly capabilities = capabilities;
  readonly features = [];
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  readonly reverted: string[] = [];
  readonly models: Array<string | null> = [];

  constructor(
    readonly id: string,
    private readonly historyFailure = false,
  ) {}

  async run() {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }
  async startTurn() {
    return { turnId: "turn-1" };
  }
  subscribe(listener: (event: AgentStreamEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    yield* [] as AgentStreamEvent[];
  }
  async getRuntimeInfo() {
    if (this.historyFailure) throw new Error("candidate config failed");
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode() {}
  async setModel(model: string | null) {
    this.models.push(model);
  }
  getPendingPermissions() {
    return [];
  }
  async respondToPermission() {}
  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt() {}
  async revertConversation({ messageId }: { messageId: string }) {
    this.reverted.push(`conversation:${messageId}`);
  }
  async revertFiles({ messageId }: { messageId: string }) {
    this.reverted.push(`files:${messageId}`);
  }
  async revertBoth({ messageId }: { messageId: string }) {
    this.reverted.push(`both:${messageId}`);
  }
  async close() {}

  emit(text: string): void {
    this.emitEvent({
      type: "timeline",
      provider: this.provider,
      item: { type: "assistant_message", text },
    });
  }

  emitEvent(event: AgentStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class Client implements AgentClient {
  readonly provider = "native-test";
  readonly capabilities = capabilities;
  readonly sessions: Session[] = [];
  failNextReload = false;

  async isAvailable() {
    return true;
  }
  async createSession(_config: AgentSessionConfig) {
    const session = new Session(`native-${this.sessions.length + 1}`);
    this.sessions.push(session);
    return session;
  }
  async resumeSession() {
    const session = new Session(`native-${this.sessions.length + 1}`, this.failNextReload);
    this.failNextReload = false;
    this.sessions.push(session);
    return session;
  }
  async fetchCatalog() {
    return { models: [], modes: [] };
  }
}

function waitFor(
  events: ProviderEvent[],
  predicate: (event: ProviderEvent) => boolean,
): Promise<void> {
  return expect.poll(() => events.some(predicate)).toBe(true);
}

describe("registerNativeProvider", () => {
  it("aggregates native text deltas into boundary snapshots with native revert identity", async () => {
    const client = new Client();
    const connection = await registerNativeProvider({
      id: "native-test",
      label: "Native test",
      createClient: () => client,
    }).connect({ versions: [1], capabilities: ["prompt.message"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "open-deltas",
      sessionId: "boundary-deltas",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    });
    await waitFor(events, (event) => event.type === "session.ready");

    const session = client.sessions[0]!;
    session.emitEvent({
      type: "timeline",
      provider: "native-test",
      item: { type: "assistant_message", messageId: "native-message", text: "hel" },
    });
    session.emitEvent({
      type: "timeline",
      provider: "native-test",
      item: { type: "assistant_message", messageId: "native-message", text: "lo" },
    });

    expect(events.filter((event) => event.type === "timeline.item")).toEqual([
      {
        type: "timeline.item",
        sessionId: "boundary-deltas",
        item: {
          type: "assistant_message",
          id: "native-message",
          revertToken: "native-message",
          messageId: "native-message",
          text: "hel",
        },
        timestamp: undefined,
      },
      {
        type: "timeline.item",
        sessionId: "boundary-deltas",
        item: {
          type: "assistant_message",
          id: "native-message",
          revertToken: "native-message",
          messageId: "native-message",
          text: "hello",
        },
        timestamp: undefined,
      },
    ]);
    await connection.close();
  });

  it("rejects non-JSON values emitted by an in-process native session", async () => {
    const client = new Client();
    const connection = await registerNativeProvider({
      id: "native-test",
      label: "Native test",
      createClient: () => client,
    }).connect({ versions: [1], capabilities: ["prompt.message"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "open-json",
      sessionId: "boundary-json",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    });
    await waitFor(events, (event) => event.type === "session.ready");
    const beforeInvalid = events.length;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    for (const invalid of [() => undefined, 1n, cyclic]) {
      expect(() =>
        client.sessions[0]!.emitEvent({
          type: "timeline",
          provider: "native-test",
          item: {
            type: "tool_call",
            callId: "invalid",
            name: "invalid",
            status: "completed",
            error: null,
            detail: { type: "unknown", input: invalid, output: null },
          },
        } as AgentStreamEvent),
      ).toThrow();
    }
    expect(events).toHaveLength(beforeInvalid);
    await connection.close();
  });

  it("derives configure and revert capabilities from the native edge and dispatches exact scopes", async () => {
    const client = new Client();
    const connection = await registerNativeProvider({
      id: "native-test",
      label: "Native test",
      createClient: () => client,
    }).connect({
      versions: [1],
      capabilities: [
        "session.configure",
        "session.revert.conversation",
        "session.revert.files",
        "session.revert.both",
      ],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    expect(connection.capabilities).toEqual([
      "session.configure",
      "session.revert.conversation",
      "session.revert.files",
      "session.revert.both",
    ]);

    await connection.send({
      type: "session.open",
      requestId: "open-capabilities",
      sessionId: "boundary-capabilities",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    });
    await waitFor(events, (event) => event.type === "session.ready");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.opened",
        capabilities: [
          "session.configure",
          "session.revert.conversation",
          "session.revert.files",
          "session.revert.both",
        ],
      }),
    );

    await connection.send({
      type: "session.configure",
      requestId: "configure-model",
      sessionId: "boundary-capabilities",
      changes: { model: "codex-model" },
    });
    await waitFor(
      events,
      (event) => event.type === "request.completed" && event.requestId === "configure-model",
    );
    expect(client.sessions[0]!.models).toEqual(["codex-model"]);

    for (const scope of ["conversation", "files", "both"] as const) {
      const requestId = `revert-${scope}`;
      await connection.send({
        type: "session.revert",
        requestId,
        sessionId: "boundary-capabilities",
        scope,
        token: "message-1",
      });
      await waitFor(
        events,
        (event) => event.type === "request.completed" && event.requestId === requestId,
      );
    }
    expect(client.sessions[0]!.reverted).toEqual([
      "conversation:message-1",
      "files:message-1",
      "both:message-1",
    ]);
    await connection.close();
  });

  it("steers an explicit command without its side effect and fails inert when inactive", async () => {
    let sideEffectCount = 0;
    let steerCount = 0;
    class CommandSession extends Session {
      override tryHandleOutOfBand(prompt: AgentPromptInput) {
        if (prompt !== "/handled") return null;
        return {
          run: async () => {
            sideEffectCount += 1;
          },
        };
      }

      async steerActiveTurn() {
        steerCount += 1;
        return { status: "accepted" as const };
      }
    }
    const client = new (class extends Client {
      override async createSession() {
        const session = new CommandSession("command-session");
        this.sessions.push(session);
        return session;
      }
    })();
    const connection = await registerNativeProvider({
      id: "native-test",
      label: "Native test",
      createClient: () => client,
    }).connect({ versions: [1], capabilities: ["prompt.command", "prompt.steer"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "open-command-session",
      sessionId: "command-session",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    });
    await waitFor(events, (event) => event.type === "session.ready");

    const session = client.sessions[0]!;
    session.emitEvent({
      type: "turn_started",
      provider: "native-test",
      turnId: "active-turn",
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "command-session",
      prompt: {
        clientMessageId: "explicit-steer-command",
        delivery: "steer",
        input: { type: "command", name: "handled", arguments: "" },
      },
    });
    await waitFor(
      events,
      (event) =>
        event.type === "session.prompt_result" &&
        event.clientMessageId === "explicit-steer-command",
    );

    expect(sideEffectCount).toBe(0);
    expect(steerCount).toBe(1);
    expect(events).toContainEqual({
      type: "session.prompt_result",
      sessionId: "command-session",
      clientMessageId: "explicit-steer-command",
      result: { type: "steer", turnId: "active-turn" },
    });

    session.emitEvent({
      type: "turn_completed",
      provider: "native-test",
      turnId: "active-turn",
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "command-session",
      prompt: {
        clientMessageId: "inactive-steer-command",
        delivery: "steer",
        input: { type: "command", name: "handled", arguments: "" },
      },
    });
    await waitFor(
      events,
      (event) =>
        event.type === "session.prompt_result" &&
        event.clientMessageId === "inactive-steer-command",
    );
    expect(sideEffectCount).toBe(0);
    expect(steerCount).toBe(1);
    expect(events).toContainEqual({
      type: "session.prompt_result",
      sessionId: "command-session",
      clientMessageId: "inactive-steer-command",
      result: { type: "failed", error: { message: "Steering is not available for this session" } },
    });
    await connection.close();
  });

  it("publishes no partial config and restores a null mode when a later setter fails", async () => {
    class TransactionalSession extends Session {
      model: string | null = null;
      mode: string | null = null;
      thinking: string | null = null;

      override async getRuntimeInfo() {
        return {
          provider: this.provider,
          sessionId: this.id,
          model: this.model,
          modeId: this.mode,
          thinkingOptionId: this.thinking,
        };
      }

      override async getAvailableModes() {
        return [{ id: "active", label: "Active" }];
      }

      override async getCurrentMode() {
        return this.mode;
      }

      override async setModel(model: string | null) {
        this.model = model;
        this.emitEvent({
          type: "model_changed",
          provider: this.provider,
          runtimeInfo: await this.getRuntimeInfo(),
        });
      }

      override async setMode(mode: string) {
        this.mode = mode;
        this.emitEvent({
          type: "mode_changed",
          provider: this.provider,
          currentModeId: mode,
          availableModes: await this.getAvailableModes(),
        });
      }

      override async setThinkingOption(thinking: string | null) {
        if (thinking === "reject") throw new Error("thinking rejected");
        this.thinking = thinking;
        this.emitEvent({
          type: "thinking_option_changed",
          provider: this.provider,
          thinkingOptionId: thinking,
        });
      }
    }

    const client = new (class extends Client {
      override async createSession() {
        const session = new TransactionalSession("transactional");
        this.sessions.push(session);
        return session;
      }
    })();
    const connection = await registerNativeProvider({
      id: "native-test",
      label: "Native test",
      createClient: () => client,
    }).connect({ versions: [1], capabilities: ["session.configure"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "open-transactional",
      sessionId: "transactional",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    });
    await waitFor(events, (event) => event.type === "session.ready");
    const configCountBefore = events.filter((event) => event.type === "session.config").length;

    await connection.send({
      type: "session.configure",
      requestId: "configure-transactional",
      sessionId: "transactional",
      changes: { model: "new-model", mode: "active", thinkingOption: "reject" },
    });
    await waitFor(
      events,
      (event) => event.type === "request.failed" && event.requestId === "configure-transactional",
    );

    expect(events.filter((event) => event.type === "session.config")).toHaveLength(
      configCountBefore,
    );
    expect(client.sessions[0]).toMatchObject({ model: null, mode: null, thinking: null });

    await connection.send({
      type: "session.configure",
      requestId: "configure-committed",
      sessionId: "transactional",
      changes: { model: "committed-model", mode: "active", thinkingOption: "committed" },
    });
    await waitFor(
      events,
      (event) => event.type === "request.completed" && event.requestId === "configure-committed",
    );
    const configs = events.filter((event) => event.type === "session.config");
    expect(configs).toHaveLength(configCountBefore + 1);
    expect(configs.at(-1)).toMatchObject({
      config: { model: "committed-model", mode: "active", thinkingOption: "committed" },
    });
    await connection.close();
  });

  it("publishes settings from the complete committed config before completing configure", async () => {
    class SettingSession extends Session {
      fastMode = false;

      async setFeature(id: string, value: unknown) {
        if (id === "reject" && value === true) throw new Error("setting rejected");
        if (id === "fast_mode") this.fastMode = value === true;
      }
    }
    const client = new (class extends Client {
      override async createSession() {
        const session = new SettingSession("settings");
        this.sessions.push(session);
        return session;
      }

      async listFeatures(config: AgentSessionConfig) {
        return [
          {
            type: "toggle" as const,
            id: "fast_mode",
            label: "Fast",
            value: config.featureValues?.fast_mode === true,
          },
        ];
      }
    })();
    const connection = await registerNativeProvider({
      id: "native-test",
      label: "Native test",
      createClient: () => client,
    }).connect({ versions: [1], capabilities: ["session.configure"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "open-settings",
      sessionId: "settings",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        settings: { fast_mode: false },
        persist: false,
      },
      history: "skip",
    });
    await waitFor(events, (event) => event.type === "session.ready");
    const configCountBefore = events.filter((event) => event.type === "session.config").length;

    await connection.send({
      type: "session.configure",
      requestId: "reject-fast-mode",
      sessionId: "settings",
      changes: { settings: { fast_mode: true, reject: true } },
    });
    await waitFor(
      events,
      (event) => event.type === "request.failed" && event.requestId === "reject-fast-mode",
    );
    expect(client.sessions[0]).toMatchObject({ fastMode: false });
    expect(events.filter((event) => event.type === "session.config")).toHaveLength(
      configCountBefore,
    );

    await connection.send({
      type: "session.configure",
      requestId: "configure-fast-mode",
      sessionId: "settings",
      changes: { settings: { fast_mode: true } },
    });
    await waitFor(
      events,
      (event) => event.type === "request.completed" && event.requestId === "configure-fast-mode",
    );

    const committedIndex = events.findIndex(
      (event) =>
        event.type === "session.config" &&
        event.config.settings[0]?.id === "fast_mode" &&
        event.config.settings[0].value === true,
    );
    const completedIndex = events.findIndex(
      (event) => event.type === "request.completed" && event.requestId === "configure-fast-mode",
    );
    expect(committedIndex).toBeGreaterThanOrEqual(0);
    expect(committedIndex).toBeLessThan(completedIndex);
    await connection.close();
  });

  it("advertises and dispatches combined-only native rewind independently", async () => {
    const client = new (class extends Client {
      override readonly capabilities = {
        ...capabilities,
        supportsRewindConversation: false,
        supportsRewindFiles: false,
        supportsRewindBoth: true,
      };

      override async createSession() {
        const session = new Session("combined-only");
        Object.defineProperties(session, {
          revertConversation: { value: undefined },
          revertFiles: { value: undefined },
        });
        this.sessions.push(session);
        return session;
      }
    })();
    const connection = await registerNativeProvider({
      id: "native-test",
      label: "Native test",
      createClient: () => client,
    }).connect({
      versions: [1],
      capabilities: ["session.revert.conversation", "session.revert.files", "session.revert.both"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    expect(connection.capabilities).toEqual(["session.revert.both"]);
    await connection.send({
      type: "session.open",
      requestId: "open-combined-only",
      sessionId: "combined-only",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    });
    await waitFor(events, (event) => event.type === "session.ready");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.opened",
        capabilities: ["session.revert.both"],
      }),
    );

    await connection.send({
      type: "session.revert",
      requestId: "revert-both",
      sessionId: "combined-only",
      scope: "both",
      token: "message-1",
    });
    await waitFor(
      events,
      (event) => event.type === "request.completed" && event.requestId === "revert-both",
    );
    expect(client.sessions[0]!.reverted).toEqual(["both:message-1"]);
    await expect(
      connection.send({
        type: "session.revert",
        requestId: "revert-conversation",
        sessionId: "combined-only",
        scope: "conversation",
        token: "message-1",
      }),
    ).rejects.toThrow("session.revert.conversation");
    await connection.close();
  });

  it("serializes configure/configure and configure/reload mutations", async () => {
    let releaseSetter: (() => void) | null = null;
    const setterCalls: string[] = [];
    class OrderedSession extends Session {
      model: string | null = null;

      override async getRuntimeInfo() {
        return { provider: this.provider, sessionId: this.id, model: this.model, modeId: null };
      }

      override async setModel(model: string | null) {
        setterCalls.push(String(model));
        if (model === "first" || model === "before-reload") {
          await new Promise<void>((resolve) => {
            releaseSetter = resolve;
          });
        }
        this.model = model;
      }
    }
    const client = new (class extends Client {
      resumeCalls = 0;

      override async createSession() {
        const session = new OrderedSession("ordered-native");
        this.sessions.push(session);
        return session;
      }

      override async resumeSession() {
        this.resumeCalls += 1;
        const session = new OrderedSession("reloaded-native");
        this.sessions.push(session);
        return session;
      }
    })();
    const connection = await registerNativeProvider({
      id: "native-test",
      label: "Native test",
      createClient: () => client,
    }).connect({ versions: [1], capabilities: ["session.configure", "session.reload"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    const config = { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true };
    await connection.send({
      type: "session.open",
      requestId: "open-ordered",
      sessionId: "ordered",
      config,
      history: "skip",
    });
    await waitFor(events, (event) => event.type === "session.ready");

    await connection.send({
      type: "session.configure",
      requestId: "configure-first",
      sessionId: "ordered",
      changes: { model: "first" },
    });
    await connection.send({
      type: "session.configure",
      requestId: "configure-second",
      sessionId: "ordered",
      changes: { model: "second" },
    });
    await expect.poll(() => setterCalls).toEqual(["first"]);
    releaseSetter!();
    await waitFor(
      events,
      (event) => event.type === "request.completed" && event.requestId === "configure-second",
    );
    expect(
      events
        .filter(
          (event) => event.type === "request.completed" && event.requestId.startsWith("configure-"),
        )
        .map((event) => (event as Extract<ProviderEvent, { type: "request.completed" }>).requestId),
    ).toEqual(["configure-first", "configure-second"]);

    setterCalls.length = 0;
    releaseSetter = null;
    await connection.send({
      type: "session.configure",
      requestId: "configure-before-reload",
      sessionId: "ordered",
      changes: { model: "before-reload" },
    });
    await connection.send({
      type: "session.reload",
      requestId: "reload-after-configure",
      sessionId: "ordered",
      config,
    });
    await expect.poll(() => releaseSetter).toBeTypeOf("function");
    expect(client.resumeCalls).toBe(0);
    releaseSetter!();
    await waitFor(
      events,
      (event) => event.type === "session.ready" && event.requestId === "reload-after-configure",
    );
    const configureIndex = events.findIndex(
      (event) =>
        event.type === "request.completed" && event.requestId === "configure-before-reload",
    );
    const reloadIndex = events.findIndex(
      (event) => event.type === "session.ready" && event.requestId === "reload-after-configure",
    );
    expect(configureIndex).toBeLessThan(reloadIndex);
    await connection.close();
  });

  it("does not advertise or complete a revert scope without its native hook", async () => {
    const client = new (class extends Client {
      override async createSession(_config: AgentSessionConfig) {
        const session = new Session("conversation-only");
        Object.defineProperties(session, {
          revertFiles: { value: undefined },
          revertBoth: { value: undefined },
        });
        this.sessions.push(session);
        return session;
      }
    })();
    const connection = await registerNativeProvider({
      id: "native-test",
      label: "Native test",
      createClient: () => client,
    }).connect({
      versions: [1],
      capabilities: ["session.revert.conversation", "session.revert.files"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "open-conversation-only",
      sessionId: "conversation-only",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    });
    await waitFor(events, (event) => event.type === "session.ready");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.opened",
        capabilities: ["session.revert.conversation"],
      }),
    );

    await expect(
      connection.send({
        type: "session.revert",
        requestId: "unsupported-files",
        sessionId: "conversation-only",
        scope: "files",
        token: "message-1",
      }),
    ).rejects.toThrow("session.revert.files");
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "request.completed", requestId: "unsupported-files" }),
    );
    await connection.close();
  });

  it("advertises tool policy only when the native edge prepares exact grants", async () => {
    const client = new Client();
    const unsupported = await registerNativeProvider({
      id: "native-test",
      label: "Native test",
      createClient: () => client,
    }).connect({ versions: [1], capabilities: ["permission.tool_policy"] });
    expect(unsupported.capabilities).toEqual([]);
    await expect(
      unsupported.send({
        type: "session.open",
        requestId: "unsupported-policy",
        sessionId: "unsupported-policy",
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          settings: {},
          toolPolicy: { preapproved: [] },
          persist: false,
        },
        history: "skip",
      }),
    ).rejects.toThrow("permission.tool_policy");
    expect(client.sessions).toEqual([]);
    await unsupported.close();

    const prepared: string[] = [];
    const supported = await registerNativeProvider({
      id: "native-test",
      label: "Native test",
      createClient: () => new Client(),
      prepareToolPolicy(toolPolicy) {
        prepared.push(...toolPolicy.preapproved.map((grant) => `${grant.server}/${grant.tool}`));
        return toolPolicy;
      },
    }).connect({ versions: [1], capabilities: ["permission.tool_policy"] });
    expect(supported.capabilities).toEqual(["permission.tool_policy"]);
    await supported.send({
      type: "session.open",
      requestId: "supported-policy",
      sessionId: "supported-policy",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        settings: {},
        toolPolicy: {
          preapproved: [{ kind: "mcp", server: "paseo", tool: "finish_execution" }],
        },
        persist: false,
      },
      history: "skip",
    });
    await expect.poll(() => prepared).toEqual(["paseo/finish_execution"]);
    await supported.close();
  });

  it("preserves the old runtime on reload failure and suppresses it after commit", async () => {
    const client = new Client();
    const connection = await registerNativeProvider({
      id: "native-test",
      label: "Native test",
      createClient: () => client,
    }).connect({ versions: [1], capabilities: ["prompt.message", "session.reload"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    const open: Extract<ProviderInput, { type: "session.open" }> = {
      type: "session.open",
      requestId: "open-1",
      sessionId: "boundary-1",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
      history: "skip",
    };
    await connection.send(open);
    await waitFor(events, (event) => event.type === "session.ready");
    const old = client.sessions[0]!;

    client.failNextReload = true;
    await connection.send({
      type: "session.reload",
      requestId: "reload-failed",
      sessionId: "boundary-1",
      config: { ...open.config, model: "broken" },
    });
    await waitFor(
      events,
      (event) => event.type === "request.failed" && event.requestId === "reload-failed",
    );
    old.emit("old still live");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ text: "old still live" }),
      }),
    );

    await connection.send({
      type: "session.reload",
      requestId: "reload-ok",
      sessionId: "boundary-1",
      config: { ...open.config, model: "new" },
    });
    await waitFor(
      events,
      (event) => event.type === "session.ready" && event.requestId === "reload-ok",
    );
    const committed = client.sessions[2]!;
    const beforeRetired = events.length;
    old.emit("retired");
    expect(events).toHaveLength(beforeRetired);
    committed.emit("candidate live");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ text: "candidate live" }),
      }),
    );
    await connection.close();
  });

  it("disposes a failed open before allowing the same boundary session ID to retry", async () => {
    class FailedOpenSession extends Session {
      closeCalls = 0;

      async listCommands(): Promise<never> {
        throw new Error("commands failed");
      }

      override async close() {
        this.closeCalls += 1;
      }
    }
    const client = new (class extends Client {
      override async createSession() {
        const session =
          this.sessions.length === 0
            ? new FailedOpenSession("failed-native")
            : new Session("retry-native");
        this.sessions.push(session);
        return session;
      }
    })();
    const connection = await registerNativeProvider({
      id: "native-test",
      label: "Native test",
      createClient: () => client,
    }).connect({ versions: [1], capabilities: ["prompt.message"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    const input: Extract<ProviderInput, { type: "session.open" }> = {
      type: "session.open",
      requestId: "failed-open",
      sessionId: "stable-boundary-id",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    };

    await connection.send(input);
    await waitFor(
      events,
      (event) => event.type === "request.failed" && event.requestId === "failed-open",
    );
    const failed = client.sessions[0] as FailedOpenSession;
    expect(failed.closeCalls).toBe(1);
    const beforeOrphan = events.length;
    failed.emit("orphan event");
    expect(events).toHaveLength(beforeOrphan);

    await connection.send({ ...input, requestId: "retry-open" });
    await waitFor(
      events,
      (event) => event.type === "session.ready" && event.requestId === "retry-open",
    );
    expect(client.sessions).toHaveLength(2);
    await connection.close();
  });

  it("waits for a delayed native session creation and closes it after connection close", async () => {
    class DelayedSession extends Session {
      closeCalls = 0;

      override async close() {
        this.closeCalls += 1;
      }
    }
    const delayedSession = new DelayedSession("delayed-native");
    let resolveCreation!: (session: AgentSession) => void;
    let creationStarted = false;
    const client = new (class extends Client {
      override createSession(): Promise<AgentSession> {
        creationStarted = true;
        return new Promise((resolve) => {
          resolveCreation = resolve;
        });
      }
    })();
    const connection = await registerNativeProvider({
      id: "native-test",
      label: "Native test",
      createClient: () => client,
    }).connect({ versions: [1], capabilities: ["prompt.message"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "delayed-open",
      sessionId: "delayed-boundary",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    });
    await expect.poll(() => creationStarted).toBe(true);

    let closeSettled = false;
    const closing = connection.close().then(() => {
      closeSettled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    resolveCreation(delayedSession);
    await closing;

    expect(delayedSession.closeCalls).toBe(1);
    expect(events).toEqual([]);
  });
});
