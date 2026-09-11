import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConfigState,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPersistence,
  type ProviderRegistration,
  type ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { randomUUID } from "node:crypto";
import { providerResultKind } from "../shared/provider-result.js";

const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.steer",
  "session.archive",
  "session.configure",
  "session.list",
  "session.persistence",
  "session.subsession",
  "session.unarchive",
  "timeline.plugin",
] as const;

interface ExampleSession {
  config: ProviderSessionConfig;
  persistence: ProviderPersistence;
  turn: number;
  activeTurnId: string | null;
}

export function createDirectExampleProvider(): ProviderRegistration {
  return {
    id: "direct-example",
    label: "Direct provider example",
    description: "A complete provider implemented directly against Paseo's provider boundary",
    icon: "icon.svg",
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return createConnection(negotiateProviderCapabilities(request.capabilities, CAPABILITIES));
    },
  };
}

function createConnection(capabilities: readonly string[]): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, ExampleSession>();
  const archived = new Set<string>();
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Provider connection is closed");
      validateAdmission(input, { sessions, capabilities });
      queueMicrotask(() => {
        if (!closed) dispatch(input, { sessions, archived, emit, capabilities });
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      sessions.clear();
      listeners.clear();
    },
  };
}

function validateAdmission(
  input: ProviderInput,
  state: Pick<ExampleState, "sessions" | "capabilities">,
): void {
  if (input.type === "session.open") {
    if (state.sessions.has(input.sessionId)) {
      throw new Error(`Session already exists: ${input.sessionId}`);
    }
    requireProviderCapabilities(state.capabilities, input);
    return;
  }
  if (!("sessionId" in input)) {
    requireProviderCapabilities(state.capabilities, input);
    return;
  }
  const session = state.sessions.get(input.sessionId);
  if (!session) throw new Error(`Unknown session: ${input.sessionId}`);
  requireProviderCapabilities(state.capabilities, input);
}

interface ExampleState {
  sessions: Map<string, ExampleSession>;
  archived: Set<string>;
  emit(event: ProviderEvent): void;
  capabilities: readonly string[];
}

function dispatch(input: ProviderInput, state: ExampleState): void {
  switch (input.type) {
    case "catalog":
      state.emit({
        type: "catalog",
        requestId: input.requestId,
        catalog: {
          models: [{ id: "example-1", label: "Example 1" }],
          modes: [{ id: "build", label: "Build" }],
          defaultModel: "example-1",
          defaultMode: "build",
        },
      });
      return;
    case "sessions":
      state.emit({
        type: "sessions",
        requestId: input.requestId,
        sessions: [...state.sessions.values()].map((session) => ({
          persistence: session.persistence,
          cwd: session.config.cwd,
          title: session.config.title,
        })),
      });
      return;
    case "session.open":
      openSession(input, state);
      return;
    case "session.prompt":
      promptSession(input, state);
      return;
    case "session.configure":
      configureSession(input, state);
      return;
    case "session.interrupt":
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    case "session.permission":
      state.emit({
        type: "session.permission_resolved",
        sessionId: input.sessionId,
        permissionId: input.permissionId,
      });
      return;
    case "session.revert":
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    case "session.archive":
      state.archived.add(persistenceKey(input.persistence));
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    case "session.unarchive":
      state.archived.delete(persistenceKey(input.persistence));
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    case "session.close":
      state.sessions.delete(input.sessionId);
      state.emit({ type: "session.closed", sessionId: input.sessionId });
      state.emit({ type: "request.completed", requestId: input.requestId });
  }
}

function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: ExampleState,
): void {
  const persistence = input.persistence ?? {
    version: 1,
    data: { nativeSessionId: `example:${input.sessionId}` },
  };
  const session: ExampleSession = {
    config: input.config,
    persistence,
    turn: 0,
    activeTurnId: null,
  };
  state.sessions.set(input.sessionId, session);
  state.emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities: state.capabilities,
    restoration: "core",
    persistence,
    title: input.config.title,
    cwd: input.config.cwd,
  });
  state.emit({ type: "session.config", sessionId: input.sessionId, config: configState(session) });
  state.emit({
    type: "session.commands",
    sessionId: input.sessionId,
    commands: [{ name: "reset", description: "Reset the example provider state" }],
  });
  if (input.history === "replay" && input.persistence) {
    state.emit({
      type: "timeline.item",
      sessionId: input.sessionId,
      item: { type: "assistant_message", id: "replayed-1", text: "Restored from persistence" },
    });
  }
  state.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
}

function promptSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  state: ExampleState,
): void {
  const session = requireSession(state, input.sessionId);
  if (input.prompt.delivery === "steer") {
    if (!session.activeTurnId) {
      state.emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message: "There is no active turn to steer" } },
      });
      return;
    }
    state.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "steer", turnId: session.activeTurnId },
    });
    return;
  }

  if (input.prompt.input.type === "command") {
    if (input.prompt.input.name !== "reset") {
      state.emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message: "Unknown command" } },
      });
      return;
    }
    session.turn = 0;
    state.emit({
      type: "session.notice",
      sessionId: input.sessionId,
      notice: { id: "reset", severity: "info", title: "Example state reset" },
    });
    state.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "completed" },
    });
    return;
  }

  session.turn += 1;
  const turnId = `turn-${session.turn}`;
  session.activeTurnId = turnId;
  const text = input.prompt.input.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  state.emit({
    type: "timeline.item",
    sessionId: input.sessionId,
    item: {
      type: "user_message",
      id: `user-${session.turn}`,
      text,
      clientMessageId: input.prompt.clientMessageId,
    },
  });
  state.emit({
    type: "session.prompt_result",
    sessionId: input.sessionId,
    clientMessageId: input.prompt.clientMessageId,
    result: { type: "turn", turnId },
  });
  state.emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
  state.emit({
    type: "timeline.item",
    sessionId: input.sessionId,
    item: { type: "assistant_message", id: `assistant-${session.turn}`, text: `Echo: ${text}` },
  });
  state.emit({
    type: "timeline.item",
    sessionId: input.sessionId,
    item: {
      type: "plugin",
      id: `provider-result-${session.turn}`,
      pluginId: "provider-direct-example",
      kind: providerResultKind,
      version: 1,
      data: { label: "Provider result", detail: `Echoed turn ${session.turn}` },
    },
  });
  publishChild(input.sessionId, session.turn, state);
  session.persistence = {
    version: 1,
    data: { nativeSessionId: `example:${input.sessionId}`, turns: session.turn },
  };
  state.emit({
    type: "session.persistence",
    sessionId: input.sessionId,
    persistence: session.persistence,
  });
  state.emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
  session.activeTurnId = null;
}

function publishChild(parentSessionId: string, turn: number, state: ExampleState): void {
  const sessionId = randomUUID();
  state.emit({
    type: "session.opened",
    sessionId,
    parentSessionId,
    capabilities: [],
    restoration: "parent",
    title: "Example child",
    cwd: requireSession(state, parentSessionId).config.cwd,
  });
  state.emit({
    type: "timeline.item",
    sessionId,
    item: {
      type: "plugin",
      id: `child-result-${turn}`,
      pluginId: "provider-direct-example",
      kind: providerResultKind,
      version: 1,
      data: { label: "Child result", detail: "Completed" },
    },
  });
  state.emit({ type: "session.ready", sessionId });
}

function configureSession(
  input: Extract<ProviderInput, { type: "session.configure" }>,
  state: ExampleState,
): void {
  const session = requireSession(state, input.sessionId);
  const changes = input.changes;
  session.config = {
    ...session.config,
    model: changes.model === null ? undefined : (changes.model ?? session.config.model),
    mode: changes.mode === null ? undefined : (changes.mode ?? session.config.mode),
    thinkingOption:
      changes.thinkingOption === null
        ? undefined
        : (changes.thinkingOption ?? session.config.thinkingOption),
    settings: changes.settings
      ? { ...session.config.settings, ...changes.settings }
      : session.config.settings,
  };
  state.emit({ type: "session.config", sessionId: input.sessionId, config: configState(session) });
  state.emit({ type: "request.completed", requestId: input.requestId });
}

function configState(session: ExampleSession): ProviderConfigState {
  return {
    model: session.config.model ?? "example-1",
    mode: session.config.mode ?? "build",
    thinkingOption: session.config.thinkingOption,
    models: [{ id: "example-1", label: "Example 1" }],
    modes: [{ id: "build", label: "Build" }],
    thinkingOptions: [],
    settings: [
      {
        type: "toggle",
        id: "concise",
        label: "Concise responses",
        value: session.config.settings.concise === true,
      },
      {
        type: "select",
        id: "voice",
        label: "Voice",
        value:
          typeof session.config.settings.voice === "string" ? session.config.settings.voice : null,
        options: [
          { label: "Calm", value: "calm" },
          { label: "Direct", value: "direct" },
        ],
      },
    ],
  };
}

function requireSession(state: ExampleState, sessionId: string): ExampleSession {
  const session = state.sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}

function persistenceKey(persistence: ProviderPersistence): string {
  return JSON.stringify(persistence);
}
