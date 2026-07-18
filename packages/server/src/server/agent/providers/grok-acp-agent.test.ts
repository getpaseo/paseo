import { expect, test, vi } from "vitest";
import type { PermissionOption, RequestPermissionRequest } from "@agentclientprotocol/sdk";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { asInternals } from "../../test-utils/class-mocks.js";
import { ACPAgentSession } from "./acp-agent.js";
import {
  GROK_ALWAYS_APPROVE_MODE_ID,
  GROK_ASK_MODE_ID,
  GROK_MODES,
  resolveGrokSessionCommand,
  transformGrokSessionResponse,
  withGrokAlwaysApproveLaunchFlag,
  writeGrokProviderMode,
} from "./grok-acp-agent.js";

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

test("writeGrokProviderMode enables native always-approve via slash command", async () => {
  const prompt = vi.fn(async () => ({ stopReason: "end_turn" }));
  const setSessionMode = vi.fn(async () => undefined);
  const setSessionConfigOption = vi.fn(async () => ({ configOptions: [] }));

  await expect(
    writeGrokProviderMode({
      connection: { prompt, setSessionMode, setSessionConfigOption } as never,
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

  expect(prompt).toHaveBeenCalledWith({
    sessionId: "session-1",
    prompt: [{ type: "text", text: "/always-approve on" }],
  });
  expect(setSessionMode).not.toHaveBeenCalled();
  expect(setSessionConfigOption).not.toHaveBeenCalled();
});

test("writeGrokProviderMode disables native always-approve when switching to Ask", async () => {
  const prompt = vi.fn(async () => ({ stopReason: "end_turn" }));

  await expect(
    writeGrokProviderMode({
      connection: { prompt } as never,
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

  expect(prompt).toHaveBeenCalledWith({
    sessionId: "session-1",
    prompt: [{ type: "text", text: "/always-approve off" }],
  });
});

test("writeGrokProviderMode does not re-prompt when already in the requested mode", async () => {
  const prompt = vi.fn(async () => ({ stopReason: "end_turn" }));

  await expect(
    writeGrokProviderMode({
      connection: { prompt } as never,
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

  expect(prompt).not.toHaveBeenCalled();
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
