import { describe, expect, it } from "vitest";
import {
  CLIENT_SLASH_COMMANDS,
  buildDraftAgentSetup,
  resolveClientSlashCommand,
  resolveDraftAgentSetup,
} from "@/client-slash-commands";
import type { Agent } from "@/stores/session-store";

function createAgent(overrides: Partial<Agent> = {}): Agent {
  const now = new Date("2026-05-15T00:00:00.000Z");
  return {
    serverId: "server-1",
    id: "agent-1",
    provider: "codex",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: now,
    lastActivityAt: now,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: "mode-current",
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: {
      provider: "codex",
      sessionId: "session-1",
      model: "runtime-model",
      modeId: "runtime-mode",
      thinkingOptionId: "runtime-thinking",
    },
    title: "Agent",
    cwd: "/repo",
    model: "agent-model",
    thinkingOptionId: "think-hard",
    options: { "web-search": true, effort: "high" },
    parentAgentId: null,
    labels: {},
    ...overrides,
    turn: overrides.turn ?? { phase: "idle", cancellationRequestId: null },
  };
}

describe("resolveClientSlashCommand", () => {
  it("declares the exact canonical client commands with their aliases", () => {
    expect(
      CLIENT_SLASH_COMMANDS.map((command) => [
        command.name,
        [...command.aliases],
        command.execution,
      ]),
    ).toEqual([
      ["exit", ["quit", "q"], "immediate"],
      ["clear", ["new"], "immediate"],
    ]);
  });

  it("resolves canonical names and aliases after trimming", () => {
    expect(resolveClientSlashCommand({ text: " /quit ", hasAttachments: false })).toMatchObject({
      name: "exit",
      kind: "archive-agent",
      execution: "immediate",
    });
    expect(resolveClientSlashCommand({ text: "/exit", hasAttachments: false })).toMatchObject({
      name: "exit",
      kind: "archive-agent",
    });
    expect(resolveClientSlashCommand({ text: "/q", hasAttachments: false })).toMatchObject({
      name: "exit",
      kind: "archive-agent",
    });
    expect(resolveClientSlashCommand({ text: "/clear", hasAttachments: false })).toMatchObject({
      name: "clear",
      kind: "replace-agent-with-draft",
    });
    expect(resolveClientSlashCommand({ text: "/new", hasAttachments: false })).toMatchObject({
      name: "clear",
      kind: "replace-agent-with-draft",
    });
  });

  it("leaves provider commands, arguments, ordinary messages, and attachment submits alone", () => {
    expect(resolveClientSlashCommand({ text: "/clear now", hasAttachments: false })).toBeNull();
    expect(resolveClientSlashCommand({ text: "/quit now", hasAttachments: false })).toBeNull();
    expect(
      resolveClientSlashCommand({ text: "/provider-command", hasAttachments: false }),
    ).toBeNull();
    expect(resolveClientSlashCommand({ text: "hello /quit", hasAttachments: false })).toBeNull();
    expect(resolveClientSlashCommand({ text: "/quit", hasAttachments: true })).toBeNull();
  });
});

describe("buildDraftAgentSetup", () => {
  it("uses fresh required options on a capable host instead of runtime snapshot values", async () => {
    const legacy = buildDraftAgentSetup(createAgent());
    const setup = await resolveDraftAgentSetup(
      {
        getLastServerInfoMessage: () => ({ features: { adaptiveAgentFeatures: true } }) as never,
        getAgentTemplate: async () => ({
          provider: "codex",
          cwd: "/repo",
          providerOptions: { caller: true },
        }),
      },
      "agent-1",
      legacy,
    );
    expect(setup).toMatchObject({ providerOptions: { caller: true } });
    expect(legacy.providerOptions).toEqual({ "web-search": true, effort: "high" });
  });

  it("keeps the established draft seed on older hosts and propagates capable-host failures", async () => {
    const legacy = buildDraftAgentSetup(createAgent());
    const old = {
      getLastServerInfoMessage: () => null,
      getAgentTemplate: async () => {
        throw new Error("must not request on old host");
      },
    };
    expect(await resolveDraftAgentSetup(old, "agent-1", legacy)).toBe(legacy);
    await expect(
      resolveDraftAgentSetup(
        {
          getLastServerInfoMessage: () => ({ features: { adaptiveAgentFeatures: true } }) as never,
          getAgentTemplate: async () => {
            throw new Error("Template read failed; reconnect and retry");
          },
        },
        "agent-1",
        legacy,
      ),
    ).rejects.toThrow("Template read failed; reconnect and retry");
  });

  it("builds draft setup from the active agent snapshot", () => {
    expect(buildDraftAgentSetup(createAgent())).toEqual({
      provider: "codex",
      cwd: "/repo",
      modeId: "mode-current",
      model: "agent-model",
      thinkingOptionId: "think-hard",
      providerOptions: {
        "web-search": true,
        effort: "high",
      },
    });
  });

  it("falls back to runtime model setup when top-level fields are absent", () => {
    expect(
      buildDraftAgentSetup(
        createAgent({
          currentModeId: null,
          model: null,
          thinkingOptionId: null,
        }),
      ),
    ).toMatchObject({
      modeId: "runtime-mode",
      model: "runtime-model",
      thinkingOptionId: "runtime-thinking",
    });
  });
});
