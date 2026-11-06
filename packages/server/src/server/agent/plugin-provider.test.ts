import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStorage } from "./agent-storage.js";
import { createIdleRuntimeCleanup } from "./idle-runtime-cleanup/index.js";
import { relative } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  ProviderConnection,
  ProviderLaunch,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentClient, AgentStreamEvent } from "./agent-sdk-types.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import { AgentManager } from "./agent-manager.js";
import { buildProviderRegistry } from "./provider-registry.js";
import { ProviderOverrideSchema } from "@getpaseo/protocol/provider-config";
import { PluginAgentClientRegistry } from "./plugin-provider.js";
import {
  isStaleProviderSessionError,
  StaleProviderSessionError,
} from "./stale-provider-session-error.js";

test("long concurrent plugin and child streams retain text-sized history and release it on archive", () => {
  const fixture = fileURLToPath(new URL("./test-utils/plugin-stream-memory.ts", import.meta.url));
  const output = execFileSync(
    process.execPath,
    ["--expose-gc", "--max-old-space-size=512", "--import", "tsx", fixture],
    {
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  const memory = JSON.parse(output) as { retained: number; closed: number };
  expect(memory.retained).toBeLessThan(24 * 1024 * 1024);
  expect(memory.closed).toBeLessThan(6 * 1024 * 1024);
});

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
  closeAcknowledgementOnly?: boolean;
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
        if (options.closeAcknowledgementOnly) return;
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

function createRewindProviderHarness(
  options: {
    reuseAnswerId?: boolean;
    forkOnRevert?: boolean;
    handleInput?: ProviderHarnessOptions["handleInput"];
  } = {},
) {
  const nativeMessages: string[] = [];
  let originalMessages: string[] | null = null;
  const harness = createProviderHarness({
    closeAcknowledgementOnly: true,
    capabilities: [
      ...CAPABILITIES,
      "session.revert.conversation",
      "session.revert.files",
      "session.revert.both",
    ],
    async handleInput(input, emit) {
      if (await options.handleInput?.(input, emit)) return true;
      if (input.type === "session.open" && input.history === "replay") {
        emit({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities: [
            ...CAPABILITIES,
            "session.revert.conversation",
            "session.revert.files",
            "session.revert.both",
          ],
          restoration: "core",
          persistence: input.persistence ?? { version: 1, data: { token: "root" } },
          cwd: input.config.cwd,
        });
        const messages =
          options.forkOnRevert &&
          (input.persistence?.data as { token?: string })?.token === "root" &&
          originalMessages
            ? originalMessages
            : nativeMessages;
        for (const [index, text] of messages.entries()) {
          emit({
            type: "timeline.item",
            sessionId: input.sessionId,
            item: { type: "user_message", id: `user-${text}`, text, revertToken: text },
          });
          emit({
            type: "timeline.item",
            sessionId: input.sessionId,
            item: {
              type: "assistant_message",
              id: options.reuseAnswerId ? `answer-${index + 1}` : `answer-${text}`,
              text: `Reply ${text}`,
            },
          });
        }
        emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        return true;
      }
      if (input.type === "session.prompt") {
        if (input.prompt.input.type !== "message") throw new Error("Expected a message");
        const text = input.prompt.input.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("");
        nativeMessages.push(text);
        const turnId = `turn-${text}`;
        emit({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: { type: "turn", turnId },
        });
        emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
        emit({
          type: "timeline.item",
          sessionId: input.sessionId,
          item: {
            type: "user_message",
            id: `user-${text}`,
            text,
            clientMessageId: input.prompt.clientMessageId,
            revertToken: text,
          },
        });
        emit({
          type: "timeline.item",
          sessionId: input.sessionId,
          item: {
            type: "assistant_message",
            id: options.reuseAnswerId ? `answer-${nativeMessages.length}` : `answer-${text}`,
            text: `Reply ${text}`,
          },
        });
        emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
        return true;
      }
      if (input.type === "session.revert") {
        if (options.forkOnRevert && input.scope !== "files") {
          originalMessages = [...nativeMessages];
          emit({
            type: "session.persistence",
            sessionId: input.sessionId,
            persistence: { version: 1, data: { token: "fork" } },
          });
        }
        if (input.scope !== "files")
          nativeMessages.splice(nativeMessages.indexOf(String(input.token)));
        emit({ type: "request.completed", requestId: input.requestId });
        return true;
      }
      return false;
    },
  });
  return { ...harness, nativeMessages };
}

async function withRewindAgent(
  run: (context: {
    manager: AgentManager;
    agentId: string;
    nativeMessages: string[];
    messages: () => string[];
  }) => Promise<void>,
  options: Parameters<typeof createRewindProviderHarness>[0] = {},
) {
  const harness = createRewindProviderHarness(options);
  const logger = createTestLogger();
  const registry = new PluginAgentClientRegistry(logger);
  registry.replace([harness.registration]);
  const manager = new AgentManager({
    logger,
    clients: registry.clients(),
    providerDefinitions: registry.definitions(),
  });
  const agent = await manager.createAgent(
    { provider: harness.registration.id, cwd: tmpdir() },
    undefined,
    { workspaceId: undefined },
  );
  const messages = () =>
    manager
      .getTimeline(agent.id)
      .flatMap((item) =>
        item.type === "user_message" || item.type === "assistant_message" ? [item.text] : [],
      );
  try {
    await manager.runAgent(agent.id, "A", { clientMessageId: "client-A" });
    await manager.runAgent(agent.id, "B", { clientMessageId: "client-B" });
    await manager.runAgent(agent.id, "C", { clientMessageId: "client-C" });
    expect(messages()).toEqual(["A", "Reply A", "B", "Reply B", "C", "Reply C"]);
    await run({ manager, agentId: agent.id, nativeMessages: harness.nativeMessages, messages });
  } finally {
    await manager.closeAgent(agent.id);
    await registry.shutdown();
  }
}

test("conversation rewind discards withdrawn plugin turns before and after a replacement prompt", async () => {
  await withRewindAgent(async ({ manager, agentId, nativeMessages, messages }) => {
    await manager.rewind(agentId, "user-B", "conversation");
    const afterRewind = messages();
    expect(nativeMessages).toEqual(["A"]);
    await manager.runAgent(agentId, "D", { clientMessageId: "client-D" });
    const afterReplacement = messages();
    expect(nativeMessages).toEqual(["A", "D"]);
    expect({ afterRewind, afterReplacement }).toEqual({
      afterRewind: ["A", "Reply A"],
      afterReplacement: ["A", "Reply A", "D", "Reply D"],
    });
  });
});

test("file-only plugin rewind preserves the conversation before and after a replacement prompt", async () => {
  await withRewindAgent(async ({ manager, agentId, nativeMessages, messages }) => {
    await manager.rewind(agentId, "user-B", "files");
    expect(nativeMessages).toEqual(["A", "B", "C"]);
    expect(messages()).toEqual(["A", "Reply A", "B", "Reply B", "C", "Reply C"]);
    await manager.runAgent(agentId, "D", { clientMessageId: "client-D" });
    expect(messages()).toEqual(["A", "Reply A", "B", "Reply B", "C", "Reply C", "D", "Reply D"]);
  });
});

test("plugin rewind restores translation state when a replacement reuses a discarded item id", async () => {
  const harness = createRewindProviderHarness({ reuseAnswerId: true });
  const registry = new PluginAgentClientRegistry(createTestLogger());
  registry.replace([harness.registration]);
  const client = registry.clients()[harness.registration.id]!;
  const session = await client.createSession({ provider: harness.registration.id, cwd: tmpdir() });
  const live: AgentStreamEvent[] = [];
  try {
    await session.run("A");
    await session.run("B");
    session.subscribe((event) => live.push(event));
    await session.revertConversation!({ messageId: "user-B" });
    live.length = 0;
    await session.run("B revised");
    const assistant = live.flatMap((event) =>
      event.type === "timeline" && event.item.type === "assistant_message" ? [event.item.text] : [],
    );
    expect(harness.nativeMessages).toEqual(["A", "B revised"]);
    expect(assistant).toEqual(["Reply B revised"]);
  } finally {
    await session.close();
    await registry.shutdown();
  }
});

async function withPluginRewindSession(
  options: Parameters<typeof createRewindProviderHarness>[0],
  run: (
    session: Awaited<ReturnType<AgentClient["createSession"]>>,
    harness: ReturnType<typeof createRewindProviderHarness>,
  ) => Promise<void>,
) {
  const harness = createRewindProviderHarness(options);
  const registry = new PluginAgentClientRegistry(createTestLogger());
  registry.replace([harness.registration]);
  const client = registry.clients()[harness.registration.id]!;
  const session = await client.createSession({ provider: harness.registration.id, cwd: tmpdir() });
  try {
    await session.run("A");
    await session.run("B");
    await session.run("C");
    await run(session, harness);
  } finally {
    await session.close();
    await registry.shutdown();
  }
}

async function pluginMessages(session: Awaited<ReturnType<AgentClient["createSession"]>>) {
  const events = await Array.fromAsync(session.streamHistory());
  return events.flatMap((event) =>
    event.type === "timeline" &&
    (event.item.type === "user_message" || event.item.type === "assistant_message")
      ? [event.item.text]
      : [],
  );
}

test("combined plugin rewind replays the retained native branch", async () => {
  await withPluginRewindSession({}, async (session) => {
    await session.revertBoth!({ messageId: "user-B" });
    expect(await pluginMessages(session)).toEqual(["A", "Reply A"]);
    await session.revertConversation!({ messageId: "user-A" });
    expect(await pluginMessages(session)).toEqual([]);
  });
});

test("plugin rewind resumes the latest persistence rather than the original handle", async () => {
  await withPluginRewindSession(
    {
      handleInput: async (input, emit) => {
        if (input.type === "session.revert")
          emit({
            type: "session.persistence",
            sessionId: input.sessionId,
            persistence: { version: 1, data: { token: "fork" } },
          });
        return false;
      },
    },
    async (session, harness) => {
      await session.revertConversation!({ messageId: "user-B" });
      expect(harness.inputs.findLast((input) => input.type === "session.open")).toMatchObject({
        persistence: { version: 1, data: { token: "fork" } },
        history: "replay",
      });
      expect(await pluginMessages(session)).toEqual(["A", "Reply A"]);
    },
  );
});

test("failed native plugin rewind preserves history and does not reopen", async () => {
  await withPluginRewindSession(
    {
      handleInput: async (input, emit) => {
        if (input.type !== "session.revert") return false;
        emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: "native rewind failed" },
        });
        return true;
      },
    },
    async (session, harness) => {
      await expect(session.revertConversation!({ messageId: "user-B" })).rejects.toThrow(
        "native rewind failed",
      );
      expect(await pluginMessages(session)).toEqual([
        "A",
        "Reply A",
        "B",
        "Reply B",
        "C",
        "Reply C",
      ]);
      expect(harness.inputs.filter((input) => input.type === "session.open")).toHaveLength(1);
    },
  );
});

test("failed plugin rewind replay blocks prompts until retry without repeating native rewind", async () => {
  let failReplay = true;
  await withPluginRewindSession(
    {
      handleInput: async (input, emit) => {
        if (input.type !== "session.open" || input.history !== "replay" || !failReplay)
          return false;
        failReplay = false;
        emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: "replay failed" },
        });
        return true;
      },
    },
    async (session, harness) => {
      await expect(session.revertConversation!({ messageId: "user-B" })).rejects.toThrow(
        "replay failed",
      );
      await expect(session.run("D")).rejects.toThrow("Retry the rewind or reload");
      await session.revertConversation!({ messageId: "user-B" });
      await session.run("D");
      expect(await pluginMessages(session)).toEqual(["A", "Reply A", "D", "Reply D"]);
      expect(harness.inputs.filter((input) => input.type === "session.revert")).toHaveLength(1);
    },
  );
});

test("retrying a failed plugin rewind replay replaces the manager timeline before prompting", async () => {
  let failReplay = true;
  await withRewindAgent(
    async ({ manager, agentId, messages }) => {
      await expect(manager.rewind(agentId, "user-B", "conversation")).rejects.toThrow(
        "replay failed",
      );
      await expect(manager.runAgent(agentId, "D")).rejects.toThrow("Retry the rewind or reload");
      await manager.rewind(agentId, "user-B", "conversation");
      expect(messages()).toEqual(["A", "Reply A"]);
      await manager.runAgent(agentId, "D");
      expect(messages()).toEqual(["A", "Reply A", "D", "Reply D"]);
    },
    {
      handleInput: async (input, emit) => {
        if (input.type !== "session.open" || input.history !== "replay" || !failReplay)
          return false;
        failReplay = false;
        emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: "replay failed" },
        });
        return true;
      },
    },
  );
});

test("reload after failed plugin rewind replay resumes the committed fork", async () => {
  let failReplay = true;
  await withRewindAgent(
    async ({ manager, agentId, messages }) => {
      await expect(manager.rewind(agentId, "user-B", "conversation")).rejects.toThrow(
        "replay failed",
      );
      await manager.reloadAgentSession(agentId, undefined, { rehydrateFromDisk: true });
      await manager.hydrateTimelineFromProvider(agentId, { force: true });
      expect(messages()).toEqual(["A", "Reply A"]);
    },
    {
      forkOnRevert: true,
      handleInput: async (input, emit) => {
        if (input.type === "session.close") {
          emit({ type: "request.completed", requestId: input.requestId });
          return true;
        }
        if (input.type !== "session.open" || input.history !== "replay" || !failReplay)
          return false;
        failReplay = false;
        emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: "replay failed" },
        });
        return true;
      },
    },
  );
});

test("closing during plugin rewind replay closes each native binding once", async () => {
  let opened!: () => void;
  let release!: () => void;
  const replayStarted = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const replayAllowed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withPluginRewindSession(
    {
      handleInput: async (input) => {
        if (input.type === "session.open" && input.history === "replay") {
          opened();
          await replayAllowed;
        }
        return false;
      },
    },
    async (session, harness) => {
      const rewind = session.revertConversation!({ messageId: "user-B" });
      await replayStarted;
      const closing = session.close();
      release();
      await Promise.all([rewind, closing]);
      const closes = harness.inputs.flatMap((input) =>
        input.type === "session.close" ? [input.sessionId] : [],
      );
      expect(closes).toHaveLength(2);
      expect(new Set(closes).size).toBe(2);
    },
  );
});

test("plugin rewind retries a failed close before reopening the native writer", async () => {
  let failClose = true;
  await withPluginRewindSession(
    {
      handleInput: async (input, emit) => {
        if (input.type !== "session.close" || !failClose) return false;
        failClose = false;
        emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: "close failed" },
        });
        return true;
      },
    },
    async (session, harness) => {
      await expect(session.revertConversation!({ messageId: "user-B" })).rejects.toThrow(
        "close failed",
      );
      expect(harness.inputs.filter((input) => input.type === "session.open")).toHaveLength(1);
      expect(await pluginMessages(session)).toEqual(["A", "Reply A"]);
      expect(harness.inputs.filter((input) => input.type === "session.revert")).toHaveLength(1);
    },
  );
});

test("plugin rewind retries permission settlement before retiring its session", async () => {
  let failPermission = true;
  await withPluginRewindSession(
    {
      handleInput: async (input) => {
        if (input.type !== "session.permission" || !failPermission) return false;
        failPermission = false;
        throw new Error("permission delivery failed");
      },
    },
    async (session, harness) => {
      const opened = harness.inputs.find((input) => input.type === "session.open")!;
      if (opened.type !== "session.open") throw new Error("Missing root");
      harness.emit({
        type: "session.permission",
        sessionId: opened.sessionId,
        request: { id: "pending", name: "tool", kind: "tool" },
      });
      await expect(session.revertConversation!({ messageId: "user-B" })).rejects.toThrow(
        "permission delivery failed",
      );
      expect(session.getPendingPermissions()).toHaveLength(1);
      expect(harness.inputs.filter((input) => input.type === "session.close")).toHaveLength(0);
      expect(await pluginMessages(session)).toEqual(["A", "Reply A"]);
      expect(session.getPendingPermissions()).toEqual([]);
      expect(harness.inputs.filter((input) => input.type === "session.permission")).toHaveLength(2);
    },
  );
});

test("plugin rewind replaces child listeners and settles old pending permissions", async () => {
  await withPluginRewindSession({}, async (session, harness) => {
    const root = harness.inputs.find((input) => input.type === "session.open")!;
    if (root.type !== "session.open") throw new Error("Missing root");
    harness.emit({
      type: "session.permission",
      sessionId: root.sessionId,
      request: { id: "old-permission", name: "tool", kind: "tool", title: "Run tool" },
    });
    expect(session.getPendingPermissions()).toHaveLength(1);
    await session.revertConversation!({ messageId: "user-B" });
    expect(session.getPendingPermissions()).toEqual([]);
    expect(harness.inputs).toContainEqual(
      expect.objectContaining({
        type: "session.permission",
        permissionId: "old-permission",
        response: { behavior: "deny", message: "Session replaced after rewind" },
      }),
    );
    harness.emit({
      type: "timeline.item",
      sessionId: "child-1",
      item: { type: "assistant_message", id: "child-message", text: "Discarded child update" },
    });
    const history = await Array.fromAsync(session.streamHistory());
    expect(history.filter((event) => event.type === "provider_subagent")).toEqual([]);
    const reopened = harness.inputs.findLast((input) => input.type === "session.open")!;
    if (reopened.type !== "session.open") throw new Error("Missing reopened root");
    harness.emit({
      type: "session.opened",
      sessionId: "child-1",
      parentSessionId: reopened.sessionId,
      capabilities: [],
      restoration: "parent",
      cwd: tmpdir(),
    });
    harness.emit({
      type: "timeline.item",
      sessionId: "child-1",
      item: { type: "assistant_message", id: "child-message", text: "New child reply" },
    });
    const next = await Array.fromAsync(session.streamHistory());
    expect(next).toContainEqual(
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({
          type: "timeline",
          item: expect.objectContaining({ text: "New child reply" }),
        }),
      }),
    );
  });
});

test("nonpersisted plugin sessions reject conversation rewind before native mutation", async () => {
  await withPluginRewindSession(
    {
      handleInput: async (input, emit) => {
        if (input.type !== "session.open") return false;
        emit({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities: [...CAPABILITIES, "session.revert.conversation", "session.revert.files"],
          restoration: "core",
          cwd: input.config.cwd,
        });
        emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        return true;
      },
    },
    async (session, harness) => {
      expect(session.capabilities.supportsRewindConversation).toBe(false);
      await expect(session.revertConversation!({ messageId: "user-B" })).rejects.toThrow(
        "requires session persistence",
      );
      expect(harness.inputs.filter((input) => input.type === "session.revert")).toEqual([]);
      await session.revertFiles!({ messageId: "user-B" });
      expect(harness.nativeMessages).toEqual(["A", "B", "C"]);
    },
  );
});

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
  test("history keeps the tool's first position when completion follows later text", async () => {
    const harness = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id]!;
    const session = await client.createSession({ provider: client.provider, cwd: "/tmp" });
    const opened = harness.inputs.find((input) => input.type === "session.open");
    if (opened?.type !== "session.open") throw new Error("missing session open");
    const tool = {
      type: "tool_call" as const,
      id: "tool-position",
      callId: "call-position",
      name: "read",
      detail: { type: "unknown" as const, input: null, output: null },
      error: null,
    };
    try {
      harness.emit({
        type: "timeline.item",
        sessionId: opened.sessionId,
        item: { ...tool, status: "running" },
      });
      harness.emit({
        type: "timeline.item",
        sessionId: opened.sessionId,
        item: { type: "assistant_message", id: "later-text", text: "Working" },
      });
      harness.emit({
        type: "timeline.item",
        sessionId: opened.sessionId,
        item: { ...tool, status: "completed" },
      });
      const items = [];
      for await (const event of session.streamHistory())
        if (event.type === "timeline") items.push(event.item);
      expect(items).toEqual([
        {
          type: "tool_call",
          callId: "call-position",
          name: "read",
          detail: tool.detail,
          error: null,
          status: "completed",
        },
        { type: "assistant_message", messageId: "later-text", text: "Working" },
      ]);
    } finally {
      await session.close();
      await registry.shutdown();
    }
  });

  test("detached text deltas preserve split surrogates and history replays one complete message", async () => {
    const harness = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id]!;
    const session = await client.createSession({ provider: client.provider, cwd: "/tmp" });
    const opened = harness.inputs.find((input) => input.type === "session.open");
    if (opened?.type !== "session.open") throw new Error("missing session open");
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const prefix = "long prefix ".repeat(10);
    const first = prefix + "a\uD83D";
    const complete = first + "\uDE00b";
    try {
      for (const text of [first, complete, complete]) {
        harness.emit({
          type: "timeline.item",
          sessionId: opened.sessionId,
          item: { type: "assistant_message", id: "split-message", text },
        });
      }
      const deltas = events.flatMap((event) =>
        event.type === "timeline" && event.item.type === "assistant_message"
          ? [event.item.text]
          : [],
      );
      expect(deltas).toEqual([first, "\uDE00b"]);
      expect(deltas.join("")).toBe(prefix + "a😀b");
      const history: AgentStreamEvent[] = [];
      for await (const event of session.streamHistory()) history.push(event);
      expect(
        history.flatMap((event) =>
          event.type === "timeline" && event.item.type === "assistant_message" ? [event.item] : [],
        ),
      ).toEqual([{ type: "assistant_message", messageId: "split-message", text: complete }]);
    } finally {
      await session.close();
      await registry.shutdown();
    }
  });

  test("stores only agent options while the plugin receives merged defaults", async () => {
    const logger = createTestLogger();
    const harness = createProviderHarness();
    const plugins = new PluginAgentClientRegistry(logger);
    plugins.replace([harness.registration]);
    const registry = buildProviderRegistry(logger, {
      pluginProviders: plugins.definitions(),
      providerOverrides: {
        "plugin-direct": { options: { nested: { base: true, replace: "config" } } },
      },
    });
    const manager = new AgentManager({
      logger,
      clients: { "plugin-direct": registry["plugin-direct"].createClient(logger) },
      providerDefinitions: { "plugin-direct": registry["plugin-direct"] },
    });
    const own = { nested: { replace: "agent" } };
    const agent = await manager.createAgent(
      { provider: "plugin-direct", cwd: tmpdir(), providerOptions: own },
      undefined,
      { workspaceId: undefined },
    );
    expect(toStoredAgentRecord(agent).config?.providerOptions).toEqual(own);
    expect(harness.inputs.find((input) => input.type === "session.open")).toMatchObject({
      config: { providerOptions: { nested: { base: true, replace: "agent" } } },
    });
    await agent.session?.close();
  });

  test.each([
    { options: { nested: { base: true, replace: "config" }, list: [1, 2], scalar: "config" } },
    { params: { nested: { base: true, replace: "config" }, list: [1, 2], scalar: "config" } },
    {
      params: { ignored: true },
      options: { nested: { base: true, replace: "config" }, list: [1, 2], scalar: "config" },
    },
  ])(
    "merges configured options into plugin session.open, preserving caller input: %j",
    async (override) => {
      const logger = createTestLogger();
      const harness = createProviderHarness();
      const plugins = new PluginAgentClientRegistry(logger);
      plugins.replace([harness.registration]);
      const registry = buildProviderRegistry(logger, {
        pluginProviders: plugins.definitions(),
        providerOverrides: { "plugin-direct": ProviderOverrideSchema.parse(override) },
      });
      const client = registry["plugin-direct"].createClient(logger);
      const defaultsSession = await client.createSession({
        provider: "plugin-direct",
        cwd: "/tmp",
      });
      const defaultsOpen = harness.inputs.findLast((input) => input.type === "session.open")!;
      expect(defaultsOpen.config.providerOptions).toEqual({
        nested: { base: true, replace: "config" },
        list: [1, 2],
        scalar: "config",
      });
      await defaultsSession.close();
      const config = {
        provider: "plugin-direct",
        cwd: "/tmp",
        providerOptions: { nested: { replace: "agent" }, list: [3], scalar: null },
      };
      const session = await client.createSession(config);
      const open = harness.inputs.findLast((input) => input.type === "session.open")!;
      expect(open.config.providerOptions).toEqual({
        nested: { base: true, replace: "agent" },
        list: [3],
        scalar: null,
      });
      expect(config.providerOptions).toEqual({
        nested: { replace: "agent" },
        list: [3],
        scalar: null,
      });
      const handle = session.describePersistence()!;
      await session.close();
      const updatedRegistry = buildProviderRegistry(logger, {
        pluginProviders: plugins.definitions(),
        providerOverrides: {
          "plugin-direct": {
            options: {
              nested: { base: false, replace: "new-config" },
              list: [4],
              scalar: "new-config",
            },
          },
        },
      });
      const resumed = await updatedRegistry["plugin-direct"]
        .createClient(logger)
        .resumeSession(handle, config);
      const resumedOpen = harness.inputs.findLast((input) => input.type === "session.open")!;
      expect(resumedOpen.config.providerOptions).toEqual({
        nested: { base: false, replace: "agent" },
        list: [3],
        scalar: null,
      });
      await resumed.close();
    },
  );

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

  test.each(["completed", "canceled", "failed"] as const)(
    "reports a reused plugin child as running until its next turn is %s",
    async (outcome) => {
      const logger = createTestLogger();
      const harness = createProviderHarness();
      const plugins = new PluginAgentClientRegistry(logger);
      plugins.replace([harness.registration]);
      const registry = buildProviderRegistry(logger, { pluginProviders: plugins.definitions() });
      const manager = new AgentManager({
        logger,
        clients: { "plugin-direct": registry["plugin-direct"].createClient(logger) },
        providerDefinitions: { "plugin-direct": registry["plugin-direct"] },
      });
      try {
        const agent = await manager.createAgent(
          { provider: "plugin-direct", cwd: tmpdir() },
          undefined,
          { workspaceId: undefined },
        );
        const open = harness.inputs.find((input) => input.type === "session.open")!;
        harness.emit({
          type: "session.opened",
          sessionId: "reusable-child",
          parentSessionId: open.sessionId,
          capabilities: [],
          restoration: "parent",
          title: "Plugin child",
          cwd: tmpdir(),
        });
        harness.emit({
          type: "session.turn",
          sessionId: "reusable-child",
          turnId: "first-turn",
          state: "started",
        });
        harness.emit({
          type: "session.turn",
          sessionId: "reusable-child",
          turnId: "first-turn",
          state: "completed",
        });
        await nextTurn();
        const [child] = manager.listProviderSubagents(agent.id);
        expect(child).toMatchObject({
          id: "reusable-child",
          title: "Plugin child",
          status: "completed",
        });

        harness.emit({
          type: "session.turn",
          sessionId: "reusable-child",
          turnId: "second-turn",
          state: "started",
        });
        await nextTurn();
        expect(manager.listProviderSubagents(agent.id)).toMatchObject([
          { id: child.id, title: child.title, status: "running" },
        ]);

        harness.emit({
          type: "session.turn",
          sessionId: "reusable-child",
          turnId: "second-turn",
          state: outcome,
        });
        await nextTurn();
        expect(manager.listProviderSubagents(agent.id)).toMatchObject([
          { id: child.id, title: child.title, status: outcome },
        ]);
      } finally {
        await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
        await plugins.shutdown();
      }
    },
  );

  test.each(["started", "completed", "canceled", "failed"] as const)(
    "replays a reused plugin child's latest turn state: %s",
    async (state) => {
      const harness = createProviderHarness({
        openChildren(rootSessionId, emit) {
          emit({
            type: "session.opened",
            sessionId: "reusable-child",
            parentSessionId: rootSessionId,
            capabilities: [],
            restoration: "parent",
            cwd: "/workspace",
          });
          for (const [turnId, turnState] of [
            ["first-turn", "started"],
            ["first-turn", "completed"],
            ["second-turn", "started"],
          ] as const) {
            emit({ type: "session.turn", sessionId: "reusable-child", turnId, state: turnState });
          }
          if (state !== "started") {
            emit({
              type: "session.turn",
              sessionId: "reusable-child",
              turnId: "second-turn",
              state,
            });
          }
        },
      });
      const registry = new PluginAgentClientRegistry(createTestLogger());
      registry.replace([harness.registration]);
      try {
        const session = await registry.clients()[harness.registration.id]!.createSession({
          provider: harness.registration.id,
          cwd: "/workspace",
        });
        const statuses = [];
        for await (const event of session.streamHistory()) {
          if (
            event.type === "provider_subagent" &&
            event.event.type === "upsert" &&
            event.event.id === "reusable-child"
          ) {
            statuses.push(event.event.status);
          }
        }
        expect(statuses.at(-1)).toBe(state === "started" ? "running" : state);
      } finally {
        await registry.shutdown();
      }
    },
  );

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

  test("leaves a completed session without a failure when its plugin provider is removed", async () => {
    const harness = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const session = await registry.clients()[harness.registration.id]!.createSession({
      provider: harness.registration.id,
      cwd: "/workspace",
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.run("hello", { clientMessageId: "completed-message" });
    expect(eventsOfType(events, "turn_completed")).toHaveLength(1);

    registry.replace([]);
    await harness.waitForClose();

    expect(eventsOfType(events, "turn_failed")).toEqual([]);
    await expect(
      session.startTurn("after reload", { clientMessageId: "after-reload" }),
    ).rejects.toBeInstanceOf(StaleProviderSessionError);
  });

  test("fails an accepted turn that has not started when its plugin provider is removed", async () => {
    const harness = createProviderHarness({
      handleInput: async (input, emit) => {
        if (input.type !== "session.prompt") return false;
        emit({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: { type: "turn", turnId: "accepted-turn" },
        });
        return true;
      },
    });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const session = await registry.clients()[harness.registration.id]!.createSession({
      provider: harness.registration.id,
      cwd: "/workspace",
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await expect(
      session.startTurn("hello", { clientMessageId: "accepted-message" }),
    ).resolves.toEqual({ turnId: "accepted-turn" });

    registry.replace([]);
    await harness.waitForClose();

    expect(eventsOfType(events, "turn_failed")).toEqual([
      expect.objectContaining({ error: "Provider connection closed" }),
    ]);
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

  test("delivers a supported steer to the active turn", async () => {
    const harness = createProviderHarness({
      capabilities: [...CAPABILITIES, "prompt.steer"],
      handleInput: async (input, emit) => {
        if (input.type !== "session.prompt") return false;
        emit({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: { type: "steer", turnId: "turn-1" },
        });
        return true;
      },
    });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id]!;
    const session = await client.createSession({ provider: harness.registration.id, cwd: "/tmp" });
    try {
      await expect(
        session.steerActiveTurn!("follow up", {
          expectedTurnId: "turn-1",
          clientMessageId: "steer-1",
          clearPendingPermissions: true,
        }),
      ).resolves.toEqual({ status: "accepted" });
      expect(harness.inputs.find((input) => input.type === "session.prompt")).toMatchObject({
        prompt: {
          delivery: "steer",
          clientMessageId: "steer-1",
          input: { type: "message", content: [{ type: "text", text: "follow up" }] },
          clearPendingPermissions: true,
        },
      });
    } finally {
      await session.close();
      registry.replace([]);
    }
  });

  test("returns unavailable when steering a provider without prompt.steer capability", async () => {
    const harness = createProviderHarness({
      capabilities: [
        "prompt.message",
        "session.configure",
        "session.persistence",
        "session.subsession",
        "permission",
      ],
    });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const session = await registry.clients()[harness.registration.id]!.createSession({
      provider: harness.registration.id,
      cwd: "/workspace",
    });
    try {
      const result = await session.steerActiveTurn!("hello", { expectedTurnId: "turn-1" });
      expect(result).toEqual({ status: "unavailable" });
      expect(harness.inputs.filter((input) => input.type === "session.prompt")).toHaveLength(0);
    } finally {
      await session.close();
      registry.replace([]);
    }
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

test("commits notices emitted during session open as the initial timeline with stable history timestamps", async () => {
  await withObservedProvider(
    {
      openChildren(sessionId, emit) {
        emit({
          type: "session.notice",
          sessionId,
          notice: {
            id: "startup",
            severity: "warning",
            title: "Full access",
            description: "Tools run without asking.",
          },
        });
        emit({
          type: "session.notice",
          sessionId,
          notice: { id: "dismissed", severity: "info", title: "Hidden", dismissed: true },
        });
      },
    },
    async (client) => {
      const session = await client.createSession({ provider: client.provider, cwd: "/workspace" });
      try {
        expect(session.initialTimeline).toEqual([
          {
            timestamp: expect.any(String),
            item: {
              type: "notification",
              level: "warning",
              message: "Full access\nTools run without asking.",
            },
          },
        ]);
        const history: AgentStreamEvent[] = [];
        for await (const event of session.streamHistory()) history.push(event);
        expect(
          history.filter(
            (event) => event.type === "timeline" && event.item.type === "notification",
          ),
        ).toEqual([
          { type: "timeline", provider: client.provider, ...session.initialTimeline![0] },
        ]);
      } finally {
        await session.close();
      }
    },
  );
});

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

describe("plugin provider launch and status", () => {
  test("resolves the executable against the provider's PATH override", async () => {
    const harness = createProviderHarness();
    const registration: ProviderRegistration = { ...harness.registration, command: ["node"] };
    const logger = createTestLogger();
    const registry = new PluginAgentClientRegistry(logger);
    registry.replace([registration]);
    try {
      const definition = registry.definitions()[registration.id]!;
      const client = definition.createClient(logger, { env: { PATH: "/paseo-nonexistent-bin" } });
      expect(await client.isAvailable()).toBe(false);
      expect(await client.getDiagnostic!()).toEqual({ diagnostic: "node not found on PATH" });
    } finally {
      await registry.shutdown();
    }
  });

  test("strips parent-session and daemon-control variables from session env overlays", async () => {
    const harness = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    try {
      const client = registry.clients()[harness.registration.id]!;
      await client.createSession(
        { provider: harness.registration.id, cwd: "/workspace" },
        {
          env: {
            SESSION_TOKEN: "session",
            PASEO_AGENT_ID: "agent",
            CLAUDECODE: "parent",
            PASEO_NODE_ENV: "development",
          },
        },
      );
      const input = harness.inputs.find((value) => value.type === "session.open");
      expect(input).toMatchObject({
        config: { env: { SESSION_TOKEN: "session", PASEO_AGENT_ID: "agent" } },
      });
      if (input?.type !== "session.open") throw new Error("Expected session.open");
      expect(input.config.env).not.toHaveProperty("CLAUDECODE");
      expect(input.config.env).not.toHaveProperty("PASEO_NODE_ENV");
    } finally {
      await registry.shutdown();
    }
  });

  test("resolves relative executable paths before sending launch data", async () => {
    const harness = createProviderHarness();
    const launches: Array<ProviderLaunch | undefined> = [];
    const registration: ProviderRegistration = {
      ...harness.registration,
      command: [relative(process.cwd(), process.execPath)],
      async connect(request) {
        launches.push(request.launch);
        return harness.registration.connect(request);
      },
    };
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([registration]);
    try {
      await registry.clients()[registration.id]!.fetchCatalog({ scope: "global" });
      expect(launches).toMatchObject([{ command: process.execPath }]);
    } finally {
      await registry.shutdown();
    }
  });

  test("a missing executable is unavailable with a diagnostic without connecting", async () => {
    const harness = createProviderHarness();
    const registration: ProviderRegistration = {
      ...harness.registration,
      command: ["paseo-nonexistent-provider-executable"],
    };
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([registration]);
    try {
      const client = registry.clients()[registration.id]!;
      expect(await client.isAvailable()).toBe(false);
      expect(await client.getDiagnostic!()).toEqual({
        diagnostic: "paseo-nonexistent-provider-executable not found on PATH",
      });
      expect(harness.inputs).toEqual([]);
    } finally {
      await registry.shutdown();
    }
  });

  test.each([
    { mode: "default" as const },
    { mode: "append" as const, args: ["extra"] },
    { mode: "replace" as const, argv: [process.execPath, "replacement"] },
  ])(
    "resolves $mode launch and supplies identical data to status, catalogue identity, and connect",
    async (command) => {
      const harness = createProviderHarness();
      const launches: Array<ProviderLaunch | undefined> = [];
      const registration: ProviderRegistration = {
        ...harness.registration,
        command: [process.execPath, "default"],
        async status(request) {
          launches.push(request.launch);
          return { available: true };
        },
        async getCatalogCacheKey(options) {
          launches.push(options.launch);
          return "shared";
        },
        async connect(request) {
          launches.push(request.launch);
          return harness.registration.connect(request);
        },
      };
      const logger = createTestLogger();
      const registry = new PluginAgentClientRegistry(logger);
      registry.replace([registration]);
      try {
        const client = registry.definitions()[registration.id]!.createClient(logger, {
          command,
          env: { PLUGIN_SETTING: "custom", CLAUDECODE: "parent" },
        });
        expect(await client.isAvailable()).toBe(true);
        expect(await client.getCatalogCacheKey!({ scope: "global" })).toBe("shared");
        await client.fetchCatalog({ scope: "global" });
        let expectedArgs = ["default"];
        if (command.mode === "replace") expectedArgs = ["replacement"];
        if (command.mode === "append") expectedArgs = ["default", "extra"];
        expect(launches).toHaveLength(3);
        for (const launch of launches) {
          expect(launch).toMatchObject({
            command: process.execPath,
            args: expectedArgs,
            env: { PLUGIN_SETTING: "custom" },
          });
          expect(launch!.env).not.toHaveProperty("CLAUDECODE");
          expect(launch!.env).not.toHaveProperty("PASEO_NODE_ENV");
        }
        expect(launches[0]).toEqual(launches[1]);
        expect(launches[1]).toEqual(launches[2]);
      } finally {
        await registry.shutdown();
      }
    },
  );
});

test("config-required plugin membership is independent of enablement and other providers", async () => {
  const logger = createTestLogger();
  const plugins = new PluginAgentClientRegistry(logger);
  const harness = createProviderHarness();
  let connections = 0;
  let probes = 0;
  plugins.replace([
    {
      ...harness.registration,
      requiresConfiguration: true,
      async status() {
        probes++;
        return { available: true };
      },
      async connect(request) {
        connections++;
        return harness.registration.connect(request);
      },
    },
  ]);
  const build = (providerOverrides = {}) =>
    buildProviderRegistry(logger, {
      pluginProviders: plugins.definitions(),
      providerOverrides,
    });
  try {
    const before = build();
    expect(before["plugin-direct"]).toBeUndefined();
    expect({ probes, connections }).toEqual({ probes: 0, connections: 0 });
    const added = build({ "plugin-direct": {} });
    expect(added["plugin-direct"].enabled).toBe(true);
    const client = added["plugin-direct"].createClient(logger);
    expect(await client.isAvailable()).toBe(true);
    const catalog = await client.fetchCatalog({ scope: "global" });
    expect(catalog.models.map((model) => model.id)).toEqual(["plugin-model"]);
    expect({ probes, connections }).toEqual({ probes: 1, connections: 1 });
    const disabled = build({ "plugin-direct": { enabled: false } });
    expect(disabled["plugin-direct"].enabled).toBe(false);
    expect(Object.keys(build())).toEqual(Object.keys(before));
    for (const id of Object.keys(before)) {
      expect(added[id].enabled).toBe(before[id].enabled);
    }
  } finally {
    await plugins.shutdown();
  }
});

test.each([true, false, "error", "wrong-session", "missing"] as const)(
  "plugin runtime safety query: %s",
  async (answer) => {
    const harness = createProviderHarness({
      capabilities:
        answer === "missing" ? CAPABILITIES : [...CAPABILITIES, "session.can_stop_runtime"],
      handleInput: async (input, emit) => {
        if (input.type !== "session.can_stop_runtime") return false;
        if (answer === "error")
          emit({
            type: "request.failed",
            requestId: input.requestId,
            error: { message: "Probe failed" },
          });
        else
          emit({
            type: "session.can_stop_runtime",
            requestId: input.requestId,
            sessionId: answer === "wrong-session" ? "child-1" : input.sessionId,
            canStop: answer === true,
          });
        return true;
      },
    });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id]!;
    const session = await client.createSession({ provider: harness.registration.id, cwd: "/tmp" });
    try {
      if (answer === "error" || answer === "wrong-session") {
        await expect(session.canStopRuntime!()).rejects.toThrow(
          answer === "error" ? "Probe failed" : "another session",
        );
      } else if (answer === "missing") expect(session.canStopRuntime).toBeUndefined();
      else expect(await session.canStopRuntime!()).toBe(answer === true);
      const requests = harness.inputs.filter((input) => input.type === "session.can_stop_runtime");
      expect(requests).toHaveLength(answer === "missing" ? 0 : 1);
      if (answer !== "missing")
        expect(requests[0]).toMatchObject({
          sessionId: harness.inputs.find((input) => input.type === "session.open")?.sessionId,
        });
    } finally {
      await session.close();
      await registry.shutdown();
    }
  },
);

test("plugin without a runtime safety capability uses baseline collection without a query", async () => {
  const home = await mkdtemp(join(tmpdir(), "plugin-baseline-cleanup-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(home, "agents"), logger);
  const harness = createProviderHarness();
  const registry = new PluginAgentClientRegistry(logger);
  registry.replace([harness.registration]);
  const manager = new AgentManager({ clients: registry.clients(), registry: storage, logger });
  const agent = await manager.createAgent(
    { provider: harness.registration.id, cwd: home },
    undefined,
    { workspaceId: undefined },
  );
  const cleanup = createIdleRuntimeCleanup({
    enabled: true,
    logger,
    runtimes: () => manager.getRuntimeCleanupCandidates(),
    now: () => agent.updatedAt.getTime() + 60 * 60_000,
    schedule: () => () => {},
  });
  try {
    expect(agent.session?.canStopRuntime).toBeUndefined();
    expect((await cleanup.sweep()).collected).toHaveLength(1);
    expect(manager.getAgent(agent.id)).toBeNull();
    expect(harness.inputs.filter((input) => input.type === "session.can_stop_runtime")).toEqual([]);
  } finally {
    await cleanup.close();
    await Promise.all(manager.listAgents().map((item) => manager.closeAgent(item.id)));
    await registry.shutdown();
    await storage.flush();
    await rm(home, { recursive: true, force: true });
  }
});

test("plugin provider import launches with runtime MCP servers and returns only saved configuration", async () => {
  const harness = createProviderHarness();
  const registry = new PluginAgentClientRegistry(createTestLogger());
  registry.replace([harness.registration]);
  const client = registry.clients()[harness.registration.id]!;
  const storedConfig = { provider: harness.registration.id, cwd: "/project" };
  const company = { type: "http", url: "https://tools.example.com/mcp" } as const;
  try {
    const imported = await client.importSession!(
      { providerHandleId: 'plugin:{"version":1,"data":{"token":"root"}}', cwd: "/project" },
      { config: { ...storedConfig, mcpServers: { company } }, storedConfig },
    );
    expect(harness.inputs).toContainEqual(
      expect.objectContaining({
        type: "session.open",
        config: expect.objectContaining({ mcpServers: { company } }),
      }),
    );
    expect(imported.config).toEqual(storedConfig);
    await imported.session.close();
  } finally {
    await registry.shutdown();
  }
});
