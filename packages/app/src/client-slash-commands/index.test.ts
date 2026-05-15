import { describe, expect, it, afterEach } from "vitest";
import {
  __private__,
  buildDraftAgentSetupSeed,
  consumeDraftAgentSetupSeed,
  resolveClientSlashCommand,
  seedDraftAgentSetup,
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
    features: [
      { type: "toggle", id: "web-search", label: "Web search", value: true },
      {
        type: "select",
        id: "effort",
        label: "Effort",
        value: "high",
        options: [{ id: "high", label: "High" }],
      },
    ],
    parentAgentId: null,
    labels: {},
    ...overrides,
  };
}

afterEach(() => {
  __private__.clearDraftAgentSetupSeeds();
});

describe("resolveClientSlashCommand", () => {
  it("resolves exact client commands after trimming", () => {
    expect(resolveClientSlashCommand({ text: " /quit ", hasAttachments: false })?.kind).toBe(
      "archive-agent",
    );
    expect(resolveClientSlashCommand({ text: "/exit", hasAttachments: false })?.kind).toBe(
      "archive-agent",
    );
    expect(resolveClientSlashCommand({ text: "/q", hasAttachments: false })?.kind).toBe(
      "archive-agent",
    );
    expect(resolveClientSlashCommand({ text: "/clear", hasAttachments: false })?.kind).toBe(
      "replace-agent-with-draft",
    );
    expect(resolveClientSlashCommand({ text: "/new", hasAttachments: false })?.kind).toBe(
      "replace-agent-with-draft",
    );
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

describe("draft setup seeds", () => {
  it("builds draft setup from the active agent snapshot", () => {
    expect(buildDraftAgentSetupSeed(createAgent())).toEqual({
      provider: "codex",
      cwd: "/repo",
      modeId: "mode-current",
      model: "agent-model",
      thinkingOptionId: "think-hard",
      featureValues: {
        "web-search": true,
        effort: "high",
      },
    });
  });

  it("falls back to runtime model setup when top-level fields are absent", () => {
    expect(
      buildDraftAgentSetupSeed(
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

  it("consumes a seeded setup once by draft id", () => {
    const setup = buildDraftAgentSetupSeed(createAgent());
    seedDraftAgentSetup({ draftId: "draft-1", setup });

    expect(consumeDraftAgentSetupSeed("draft-1")).toEqual(setup);
    expect(consumeDraftAgentSetupSeed("draft-1")).toBeNull();
  });
});
