import { describe, expect, it } from "vitest";
import {
  buildForkDraftSetup,
  buildUnavailableProviderForkContext,
  isUnavailableProviderError,
  type ForkAgentSource,
} from "./fork-draft-setup";

function makeAgent(overrides: Partial<ForkAgentSource> = {}): ForkAgentSource {
  return {
    provider: "claude",
    cwd: "/repo",
    currentModeId: "bypassPermissions",
    model: "claude-opus-5-5",
    thinkingOptionId: "high",
    runtimeInfo: null,
    features: [{ id: "fast_mode", value: true }],
    projectPlacement: null,
    ...overrides,
  } as ForkAgentSource;
}

describe("buildForkDraftSetup", () => {
  it("keeps the source provider and its selections when the provider is selectable", () => {
    const setup = buildForkDraftSetup(makeAgent(), ["codex", "claude"]);

    expect(setup).toMatchObject({
      provider: "claude",
      cwd: "/repo",
      modeId: "bypassPermissions",
      model: "claude-opus-5-5",
      thinkingOptionId: "high",
      featureValues: { fast_mode: true },
    });
  });

  it("falls back to the first selectable provider and drops provider-specific selections", () => {
    const setup = buildForkDraftSetup(makeAgent(), ["codex", "pi"]);

    expect(setup).toEqual({
      provider: "codex",
      cwd: "/repo",
      modeId: null,
      model: null,
      thinkingOptionId: null,
      featureValues: {},
    });
  });

  it("keeps the source provider when the provider catalogue is unknown", () => {
    expect(buildForkDraftSetup(makeAgent(), null)?.provider).toBe("claude");
    expect(buildForkDraftSetup(makeAgent(), [])?.provider).toBe("claude");
  });

  it("still seeds a draft when the source agent has no provider", () => {
    expect(buildForkDraftSetup(makeAgent({ provider: undefined }), ["codex"])).toBeUndefined();
  });
});

describe("isUnavailableProviderError", () => {
  it("matches the daemon's unavailable-provider failures", () => {
    expect(
      isUnavailableProviderError(
        new Error("Agent 4c275103 references unavailable provider 'claude'"),
      ),
    ).toBe(true);
    expect(isUnavailableProviderError(new Error("Provider 'claude' is disabled"))).toBe(true);
    expect(isUnavailableProviderError(new Error("Provider 'pi' is not available."))).toBe(true);
  });

  it("does not swallow unrelated fork failures", () => {
    expect(isUnavailableProviderError(new Error("host disconnected"))).toBe(false);
    expect(isUnavailableProviderError(undefined)).toBe(false);
  });
});

describe("buildUnavailableProviderForkContext", () => {
  it("produces an empty chat-history attachment that explains the gap", () => {
    const payload = buildUnavailableProviderForkContext("agent-1");

    expect(payload.agentId).toBe("agent-1");
    expect(payload.itemCount).toBe(0);
    expect(payload.error).toBeNull();
    expect(payload.attachment).toMatchObject({
      type: "text",
      contextKind: "chat_history",
      title: "Chat history",
    });
    expect(payload.attachment?.text).toContain("<chat-history-summary>");
    expect(payload.attachment?.text).toContain("No chat history to display");
  });
});
