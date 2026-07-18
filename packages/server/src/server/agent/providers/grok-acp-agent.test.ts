import { expect, test } from "vitest";
import type {
  PermissionOption,
  RequestPermissionRequest,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { asInternals } from "../../test-utils/class-mocks.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../agent-sdk-types.js";
import {
  isDefaultAgentCreateConfigUnattended,
  resolveDefaultAgentCreateConfig,
} from "../create-agent-mode.js";
import { ACPAgentSession, deriveModesFromACP } from "./acp-agent.js";
import {
  GROK_ALWAYS_APPROVE_MODE_ID,
  GROK_ASK_MODE_ID,
  GROK_MODES,
  resolveGrokSessionCommand,
  transformGrokSessionResponse,
  withGrokAlwaysApproveLaunchFlag,
  writeGrokProviderMode,
} from "./grok-acp-agent.js";
import {
  GROK_SESSION_UPDATE_METHOD,
  buildGrokBackgroundTaskCallId,
  isGrokHiddenFromScrollbackUserChunk,
  mapGrokExtensionNotificationToTimelineItems,
} from "./grok-background-tasks.js";

function createRecordingGrokConnection() {
  const prompts: Array<{ sessionId: string; prompt: Array<{ type: string; text: string }> }> = [];
  const sessionModeCalls: unknown[] = [];
  const configOptionCalls: unknown[] = [];

  return {
    prompts,
    sessionModeCalls,
    configOptionCalls,
    connection: {
      prompt: async (params: {
        sessionId: string;
        prompt: Array<{ type: string; text: string }>;
      }) => {
        prompts.push(params);
        return { stopReason: "end_turn" };
      },
      setSessionMode: async (params: unknown) => {
        sessionModeCalls.push(params);
      },
      setSessionConfigOption: async (params: unknown) => {
        configOptionCalls.push(params);
        return { configOptions: [] };
      },
    },
  };
}

test("GROK_MODES is the full canonical definition including visuals and unattended", () => {
  expect(GROK_MODES).toEqual([
    {
      id: GROK_ASK_MODE_ID,
      label: "Ask",
      description: "Prompt before shell and tool executions",
      icon: "ShieldCheck",
      colorTier: "safe",
    },
    {
      id: GROK_ALWAYS_APPROVE_MODE_ID,
      label: "Always Approve",
      description:
        "Auto-approve all tool executions for this session via Grok's native always-approve mode. Allows potentially destructive shell commands and file operations.",
      icon: "ShieldOff",
      colorTier: "dangerous",
      isUnattended: true,
    },
  ]);
});

test("withGrokAlwaysApproveLaunchFlag injects flag after agent subcommand", () => {
  expect(withGrokAlwaysApproveLaunchFlag(["grok", "agent", "stdio"], true)).toEqual([
    "grok",
    "agent",
    "--always-approve",
    "stdio",
  ]);
});

test("withGrokAlwaysApproveLaunchFlag is idempotent and strips yolo aliases when disabling", () => {
  expect(
    withGrokAlwaysApproveLaunchFlag(["grok", "agent", "--always-approve", "stdio"], true),
  ).toEqual(["grok", "agent", "--always-approve", "stdio"]);
  expect(withGrokAlwaysApproveLaunchFlag(["grok", "agent", "--yolo", "stdio"], false)).toEqual([
    "grok",
    "agent",
    "stdio",
  ]);
});

test("resolveGrokSessionCommand enables launch flag only for Always Approve mode", () => {
  expect(
    resolveGrokSessionCommand(["grok", "agent", "stdio"], {
      provider: "acp",
      cwd: "/tmp",
      modeId: GROK_ALWAYS_APPROVE_MODE_ID,
    }),
  ).toEqual(["grok", "agent", "--always-approve", "stdio"]);
  expect(
    resolveGrokSessionCommand(["grok", "agent", "stdio"], {
      provider: "acp",
      cwd: "/tmp",
      modeId: GROK_ASK_MODE_ID,
    }),
  ).toEqual(["grok", "agent", "stdio"]);
});

test("transformGrokSessionResponse injects Ask and Always Approve when ACP advertises no modes", () => {
  const transformed = transformGrokSessionResponse({
    sessionId: "session-1",
    modes: null,
  });

  expect(transformed.modes?.availableModes?.map((mode) => mode.id)).toEqual([
    GROK_ASK_MODE_ID,
    GROK_ALWAYS_APPROVE_MODE_ID,
  ]);
  expect(transformed.modes?.currentModeId).toBe(GROK_ASK_MODE_ID);
});

test("transformGrokSessionResponse preserves configured Always Approve when injecting modes", () => {
  const transformed = transformGrokSessionResponse(
    {
      sessionId: "session-1",
      modes: null,
    },
    {
      provider: "acp",
      cwd: "/tmp",
      modeId: GROK_ALWAYS_APPROVE_MODE_ID,
    },
  );

  expect(transformed.modes?.currentModeId).toBe(GROK_ALWAYS_APPROVE_MODE_ID);
});

test("transformGrokSessionResponse appends Always Approve without dropping upstream modes", () => {
  const transformed = transformGrokSessionResponse({
    sessionId: "session-1",
    modes: {
      currentModeId: "plan",
      availableModes: [
        {
          id: "plan",
          name: "Plan",
          description: "Plan mode",
        },
      ],
    },
  });

  expect(transformed.modes?.availableModes?.map((mode) => mode.id)).toEqual([
    "plan",
    GROK_ASK_MODE_ID,
    GROK_ALWAYS_APPROVE_MODE_ID,
  ]);
  expect(transformed.modes?.currentModeId).toBe("plan");
});

test("transform + deriveModesFromACP keeps Always Approve unattended and visual metadata", () => {
  const transformed = transformGrokSessionResponse(
    {
      sessionId: "session-1",
      modes: null,
    },
    {
      provider: "acp",
      cwd: "/tmp",
      modeId: GROK_ALWAYS_APPROVE_MODE_ID,
    },
  );

  const derived = deriveModesFromACP(GROK_MODES, transformed.modes);

  expect(derived.currentModeId).toBe(GROK_ALWAYS_APPROVE_MODE_ID);
  expect(derived.modes).toEqual([
    {
      id: GROK_ASK_MODE_ID,
      label: "Ask",
      description: "Prompt before shell and tool executions",
      icon: "ShieldCheck",
      colorTier: "safe",
    },
    {
      id: GROK_ALWAYS_APPROVE_MODE_ID,
      label: "Always Approve",
      description:
        "Auto-approve all tool executions for this session via Grok's native always-approve mode. Allows potentially destructive shell commands and file operations.",
      icon: "ShieldOff",
      colorTier: "dangerous",
      isUnattended: true,
    },
  ]);
});

test("derived session modes mark Always Approve as unattended for create-config inheritance", () => {
  const transformed = transformGrokSessionResponse({
    sessionId: "session-1",
    modes: null,
  });
  const availableModes = deriveModesFromACP(GROK_MODES, transformed.modes).modes;

  expect(
    isDefaultAgentCreateConfigUnattended({
      modeId: GROK_ALWAYS_APPROVE_MODE_ID,
      availableModes,
      config: {
        provider: "acp",
        cwd: "/tmp",
        modeId: GROK_ALWAYS_APPROVE_MODE_ID,
      },
      features: [],
    }),
  ).toBe(true);

  expect(
    isDefaultAgentCreateConfigUnattended({
      modeId: GROK_ASK_MODE_ID,
      availableModes,
      config: {
        provider: "acp",
        cwd: "/tmp",
        modeId: GROK_ASK_MODE_ID,
      },
      features: [],
    }),
  ).toBe(false);

  // Unattended create needs the unattended mode id from availableModes.
  const resolved = resolveDefaultAgentCreateConfig({
    provider: "acp",
    requestedMode: undefined,
    unattended: true,
    availableModes,
    parent: null,
    featureValues: undefined,
  });
  expect(resolved.modeId).toBe(GROK_ALWAYS_APPROVE_MODE_ID);
});

test("writeGrokProviderMode enables native always-approve via slash command", async () => {
  const recording = createRecordingGrokConnection();

  await expect(
    writeGrokProviderMode({
      connection: recording.connection as never,
      sessionId: "session-1",
      requestedModeId: GROK_ALWAYS_APPROVE_MODE_ID,
      currentModeId: GROK_ASK_MODE_ID,
      selection: {
        availableMode: GROK_MODES[1] ?? null,
        configOption: null,
        configChoice: null,
        hasAvailableModes: true,
      },
      configOptions: [],
      logger: createTestLogger(),
    }),
  ).resolves.toEqual({
    handled: true,
    currentModeId: GROK_ALWAYS_APPROVE_MODE_ID,
  });

  expect(recording.prompts).toEqual([
    {
      sessionId: "session-1",
      prompt: [{ type: "text", text: "/always-approve on" }],
    },
  ]);
  expect(recording.sessionModeCalls).toEqual([]);
  expect(recording.configOptionCalls).toEqual([]);
});

test("writeGrokProviderMode disables native always-approve when switching to Ask", async () => {
  const recording = createRecordingGrokConnection();

  await expect(
    writeGrokProviderMode({
      connection: recording.connection as never,
      sessionId: "session-1",
      requestedModeId: GROK_ASK_MODE_ID,
      currentModeId: GROK_ALWAYS_APPROVE_MODE_ID,
      selection: {
        availableMode: GROK_MODES[0] ?? null,
        configOption: null,
        configChoice: null,
        hasAvailableModes: true,
      },
      configOptions: [],
      logger: createTestLogger(),
    }),
  ).resolves.toEqual({
    handled: true,
    currentModeId: GROK_ASK_MODE_ID,
  });

  expect(recording.prompts).toEqual([
    {
      sessionId: "session-1",
      prompt: [{ type: "text", text: "/always-approve off" }],
    },
  ]);
});

test("writeGrokProviderMode does not re-prompt when already in the requested mode", async () => {
  const recording = createRecordingGrokConnection();

  await expect(
    writeGrokProviderMode({
      connection: recording.connection as never,
      sessionId: "session-1",
      requestedModeId: GROK_ALWAYS_APPROVE_MODE_ID,
      currentModeId: GROK_ALWAYS_APPROVE_MODE_ID,
      selection: {
        availableMode: GROK_MODES[1] ?? null,
        configOption: null,
        configChoice: null,
        hasAvailableModes: true,
      },
      configOptions: [],
      logger: createTestLogger(),
    }),
  ).resolves.toEqual({
    handled: true,
    currentModeId: GROK_ALWAYS_APPROVE_MODE_ID,
  });

  expect(recording.prompts).toEqual([]);
});

test("writeGrokProviderMode leaves unknown ACP modes to the generic path", async () => {
  await expect(
    writeGrokProviderMode({
      connection: {} as never,
      sessionId: "session-1",
      requestedModeId: "plan",
      currentModeId: GROK_ASK_MODE_ID,
      selection: {
        availableMode: { id: "plan", label: "Plan" },
        configOption: null,
        configChoice: null,
        hasAvailableModes: true,
      },
      configOptions: [],
      logger: createTestLogger(),
    }),
  ).resolves.toEqual({ handled: false });
});

test("Always Approve fallback auto-approves ACP permission requests without UI events", async () => {
  const session = new ACPAgentSession(
    {
      provider: "acp",
      cwd: "/tmp/paseo-grok-test",
      modeId: GROK_ALWAYS_APPROVE_MODE_ID,
    },
    {
      provider: "acp",
      logger: createTestLogger(),
      defaultCommand: ["grok", "agent", "stdio"],
      defaultModes: GROK_MODES,
      autoApproveModeIds: [GROK_ALWAYS_APPROVE_MODE_ID],
      providerModeWriter: writeGrokProviderMode,
      sessionResponseTransformer: transformGrokSessionResponse,
      resolveSessionCommand: resolveGrokSessionCommand,
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
    },
  );

  const events: Array<{ type: string }> = [];
  session.subscribe((event) => {
    events.push(event);
  });

  asInternals<{
    sessionId: string | null;
    currentMode: string | null;
    availableModes: typeof GROK_MODES;
  }>(session).sessionId = "session-1";
  asInternals<{ currentMode: string | null }>(session).currentMode = GROK_ALWAYS_APPROVE_MODE_ID;

  const permissionOptions: PermissionOption[] = [
    { optionId: "allow-once", name: "Allow", kind: "allow_once" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];

  await expect(
    session.requestPermission({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "tool-1",
        title: "Run shell",
        kind: "execute",
        status: "pending",
      },
      options: permissionOptions,
    } satisfies RequestPermissionRequest),
  ).resolves.toEqual({
    outcome: { outcome: "selected", optionId: "allow-once" },
  });

  expect(events.some((event) => event.type === "permission_requested")).toBe(false);
});

test("Ask mode still surfaces ACP permission requests", async () => {
  const session = new ACPAgentSession(
    {
      provider: "acp",
      cwd: "/tmp/paseo-grok-test",
      modeId: GROK_ASK_MODE_ID,
    },
    {
      provider: "acp",
      logger: createTestLogger(),
      defaultCommand: ["grok", "agent", "stdio"],
      defaultModes: GROK_MODES,
      autoApproveModeIds: [GROK_ALWAYS_APPROVE_MODE_ID],
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
    },
  );

  const events: Array<{ type: string; request?: { id: string } }> = [];
  session.subscribe((event) => {
    events.push(event as { type: string; request?: { id: string } });
  });

  asInternals<{ sessionId: string | null; currentMode: string | null }>(session).sessionId =
    "session-1";
  asInternals<{ currentMode: string | null }>(session).currentMode = GROK_ASK_MODE_ID;

  const permission = session.requestPermission({
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tool-2",
      title: "Edit file",
      kind: "edit",
      status: "pending",
    },
    options: [
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  } satisfies RequestPermissionRequest);

  await Promise.resolve();
  const requested = events.find((event) => event.type === "permission_requested");
  expect(requested?.request?.id).toEqual(expect.any(String));

  await session.respondToPermission(requested!.request!.id, { behavior: "allow" });
  await expect(permission).resolves.toEqual({
    outcome: { outcome: "selected", optionId: "allow-once" },
  });
});

const GROK_ACP_CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
} as const;

function createGrokBackgroundTaskSession(): ACPAgentSession {
  return new ACPAgentSession(
    {
      provider: "grok",
      cwd: "/tmp/paseo-grok-bg-test",
    },
    {
      provider: "grok",
      logger: createTestLogger(),
      defaultCommand: ["grok", "agent", "stdio"],
      defaultModes: GROK_MODES,
      capabilities: GROK_ACP_CAPABILITIES,
      shouldSuppressUserMessageChunk: isGrokHiddenFromScrollbackUserChunk,
      extensionNotificationHandler: mapGrokExtensionNotificationToTimelineItems,
    },
  );
}

function createGenericAcpSession(): ACPAgentSession {
  return new ACPAgentSession(
    {
      provider: "claude-acp",
      cwd: "/tmp/paseo-generic-acp-test",
    },
    {
      provider: "claude-acp",
      logger: createTestLogger(),
      defaultCommand: ["claude", "--acp"],
      defaultModes: [],
      capabilities: GROK_ACP_CAPABILITIES,
    },
  );
}

function collectTimelineItems(session: ACPAgentSession): AgentTimelineItem[] {
  const items: AgentTimelineItem[] = [];
  session.subscribe((event: AgentStreamEvent) => {
    if (event.type === "timeline") {
      items.push(event.item);
    }
  });
  return items;
}

function hiddenUserChunk(
  text: string,
  messageId?: string | null,
): Extract<SessionUpdate, { sessionUpdate: "user_message_chunk" }> {
  return {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text },
    ...(messageId !== undefined ? { messageId } : {}),
    _meta: { hideFromScrollback: true, modelId: "grok-4.5" },
  };
}

test("live Grok session suppresses hideFromScrollback user chunks", async () => {
  const session = createGrokBackgroundTaskSession();
  const items = collectTimelineItems(session);
  asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";

  await session.sessionUpdate({
    sessionId: "session-1",
    update: hiddenUserChunk(
      '<system-reminder>Background task "task-1" completed (exit code: 0).</system-reminder>',
      "msg-hidden",
    ),
  });
  await session.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "real user prompt" },
      messageId: "msg-visible",
    },
  });

  expect(items).toEqual([
    { type: "user_message", text: "real user prompt", messageId: "msg-visible" },
  ]);
});

test("history replay also suppresses hideFromScrollback user chunks", async () => {
  const session = createGrokBackgroundTaskSession();
  const internals = asInternals<{
    sessionId: string | null;
    replayingHistory: boolean;
    persistedHistory: AgentTimelineItem[];
  }>(session);
  internals.sessionId = "session-1";
  internals.replayingHistory = true;

  await session.sessionUpdate({
    sessionId: "session-1",
    update: hiddenUserChunk("<system-reminder>Background task completed</system-reminder>"),
  });
  await session.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "visible during load" },
      messageId: "msg-load",
    },
  });

  expect(internals.persistedHistory).toEqual([
    { type: "user_message", text: "visible during load", messageId: "msg-load" },
  ]);
});

test("hidden chunk without messageId does not contaminate a later visible user message", async () => {
  const session = createGrokBackgroundTaskSession();
  const items = collectTimelineItems(session);
  asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";

  await session.sessionUpdate({
    sessionId: "session-1",
    update: hiddenUserChunk("<system-reminder>hidden wake-up without messageId</system-reminder>"),
  });
  await session.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "first visible" },
    },
  });
  await session.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: " second" },
    },
  });

  // User chunks emit accumulated text per chunk; the hidden wake-up must never
  // enter messageAssemblies for the shared no-messageId key.
  expect(items.map((item) => ("text" in item ? item.text : null))).toEqual([
    "first visible",
    "first visible second",
  ]);
  expect(items.every((item) => !("text" in item && item.text.includes("system-reminder")))).toBe(
    true,
  );
});

test("generic ACP provider still renders hideFromScrollback chunks as user messages", async () => {
  const session = createGenericAcpSession();
  const items = collectTimelineItems(session);
  asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";

  await session.sessionUpdate({
    sessionId: "session-1",
    update: hiddenUserChunk("<system-reminder>would be hidden only for Grok</system-reminder>"),
  });

  expect(items).toEqual([
    {
      type: "user_message",
      text: "<system-reminder>would be hidden only for Grok</system-reminder>",
    },
  ]);
});

test("Grok task_backgrounded then task_completed project one synthetic tool lifecycle", async () => {
  const session = createGrokBackgroundTaskSession();
  const items = collectTimelineItems(session);
  asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";
  const callId = buildGrokBackgroundTaskCallId("task-lifecycle");

  await session.extNotification(GROK_SESSION_UPDATE_METHOD, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "task_backgrounded",
      task_snapshot: {
        task_id: "task-lifecycle",
        command: "npm test",
        cwd: "/tmp",
        output: null,
        truncated: false,
        exit_code: null,
        signal: null,
        completed: false,
        kind: "bash",
      },
    },
  });
  await session.extNotification(GROK_SESSION_UPDATE_METHOD, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "task_completed",
      task_snapshot: {
        task_id: "task-lifecycle",
        command: "npm test",
        cwd: "/tmp",
        output: "ok",
        truncated: false,
        exit_code: 0,
        signal: null,
        completed: true,
        kind: "bash",
      },
      will_wake: true,
    },
  });

  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ type: "tool_call", callId, status: "running" });
  expect(items[1]).toMatchObject({ type: "tool_call", callId, status: "completed", error: null });
});

test("Grok failed, canceled, missing-output, and truncated task states", async () => {
  const session = createGrokBackgroundTaskSession();
  const items = collectTimelineItems(session);
  asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";

  await session.extNotification(GROK_SESSION_UPDATE_METHOD, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "task_completed",
      task_snapshot: {
        task_id: "fail",
        command: "false",
        exit_code: 1,
        signal: null,
        output: "err",
        truncated: false,
        completed: true,
        kind: "bash",
      },
    },
  });
  await session.extNotification(GROK_SESSION_UPDATE_METHOD, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "task_completed",
      task_snapshot: {
        task_id: "cancel",
        command: "sleep 99",
        exit_code: null,
        signal: "SIGINT",
        output: null,
        truncated: false,
        completed: true,
        kind: "bash",
      },
    },
  });
  await session.extNotification(GROK_SESSION_UPDATE_METHOD, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "task_completed",
      task_snapshot: {
        task_id: "no-out",
        command: "true",
        exit_code: 0,
        signal: null,
        output: null,
        truncated: false,
        completed: true,
        kind: "bash",
      },
    },
  });
  await session.extNotification(GROK_SESSION_UPDATE_METHOD, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "task_completed",
      task_snapshot: {
        task_id: "trunc",
        command: "yes",
        exit_code: 0,
        signal: null,
        output: "partial",
        truncated: true,
        completed: true,
        kind: "bash",
      },
    },
  });

  expect(items).toHaveLength(4);
  expect(items[0]).toMatchObject({
    callId: buildGrokBackgroundTaskCallId("fail"),
    status: "failed",
  });
  expect(items[1]).toMatchObject({
    callId: buildGrokBackgroundTaskCallId("cancel"),
    status: "canceled",
  });
  expect(items[2]).toMatchObject({
    callId: buildGrokBackgroundTaskCallId("no-out"),
    status: "completed",
    detail: expect.objectContaining({ text: expect.stringContaining("(no output)") }),
  });
  expect(items[3]).toMatchObject({
    callId: buildGrokBackgroundTaskCallId("trunc"),
    status: "completed",
    detail: expect.objectContaining({ text: expect.stringContaining("Output truncated") }),
  });
});

test("repeated and history-replayed Grok task notifications keep stable callId", async () => {
  const session = createGrokBackgroundTaskSession();
  const liveItems = collectTimelineItems(session);
  const internals = asInternals<{
    sessionId: string | null;
    replayingHistory: boolean;
    persistedHistory: AgentTimelineItem[];
  }>(session);
  internals.sessionId = "session-1";
  const callId = buildGrokBackgroundTaskCallId("dedupe-1");
  const completedPayload = {
    sessionId: "session-1",
    update: {
      sessionUpdate: "task_completed" as const,
      task_snapshot: {
        task_id: "dedupe-1",
        command: "echo hi",
        exit_code: 0,
        signal: null,
        output: "hi",
        truncated: false,
        completed: true,
        kind: "bash",
      },
    },
  };

  await session.extNotification(GROK_SESSION_UPDATE_METHOD, completedPayload);
  await session.extNotification(GROK_SESSION_UPDATE_METHOD, completedPayload);
  expect(liveItems).toHaveLength(2);
  expect(liveItems[0]).toMatchObject({ callId, status: "completed" });
  expect(liveItems[1]).toMatchObject({ callId, status: "completed" });

  internals.replayingHistory = true;
  await session.extNotification(GROK_SESSION_UPDATE_METHOD, completedPayload);
  expect(internals.persistedHistory).toEqual([
    expect.objectContaining({ type: "tool_call", callId, status: "completed" }),
  ]);
});

test("malformed and wrong-session Grok extension notifications are ignored safely", async () => {
  const session = createGrokBackgroundTaskSession();
  const items = collectTimelineItems(session);
  asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";

  await session.extNotification(GROK_SESSION_UPDATE_METHOD, {
    sessionId: "other-session",
    update: {
      sessionUpdate: "task_completed",
      task_snapshot: {
        task_id: "x",
        command: "echo",
        exit_code: 0,
        signal: null,
        output: "x",
        truncated: false,
        completed: true,
        kind: "bash",
      },
    },
  });
  await session.extNotification(GROK_SESSION_UPDATE_METHOD, {
    sessionId: "session-1",
    update: { sessionUpdate: "task_completed" },
  });
  await session.extNotification("_other/vendor", {
    sessionId: "session-1",
    update: { sessionUpdate: "task_completed" },
  });

  expect(items).toEqual([]);
});
