import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { buildAgentProfileRosterSummary, formatShortModelLabel } from "./profile-summary";

const formatFeatureCount = (count: number) => `${count} option${count === 1 ? "" : "s"}`;

describe("formatShortModelLabel", () => {
  it("keeps plain model names intact with no prefix", () => {
    expect(formatShortModelLabel("Claude Opus 4.6")).toEqual({
      prefix: null,
      name: "Claude Opus 4.6",
    });
  });

  it("splits slash-qualified router model ids into prefix and short name", () => {
    expect(formatShortModelLabel("openrouter/moonshotai/kimi-k3.1-pro")).toEqual({
      prefix: "openrouter/moonshotai/",
      name: "kimi-k3.1-pro",
    });
  });

  it("ignores leading or trailing slashes", () => {
    expect(formatShortModelLabel("/leading")).toEqual({ prefix: null, name: "/leading" });
    expect(formatShortModelLabel("trailing/")).toEqual({ prefix: null, name: "trailing/" });
  });
});

describe("buildAgentProfileRosterSummary", () => {
  const entries: ProviderSnapshotEntry[] = [
    {
      provider: "opencode",
      status: "ready",
      enabled: true,
      label: "OpenCode",
      models: [
        {
          provider: "opencode",
          id: "openrouter/moonshotai/kimi-k3.1-pro",
          label: "openrouter/moonshotai/kimi-k3.1-pro",
        },
      ],
      modes: [{ id: "build", label: "Build" }],
    },
  ];

  it("separates short model label from provider/mode/thinking/option details", () => {
    const profile: AgentProfile = {
      id: "p1",
      name: "Kimi fast",
      provider: "opencode",
      model: "openrouter/moonshotai/kimi-k3.1-pro",
      modeId: "build",
      thinkingOptionId: "high",
      options: { fast_mode: true },
    };

    const summary = buildAgentProfileRosterSummary({ profile, entries, formatFeatureCount });

    expect(summary.providerLabel).toBe("OpenCode");
    expect(summary.modelLabel).toBe("kimi-k3.1-pro");
    expect(summary.modelPrefix).toBe("openrouter/moonshotai/");
    expect(summary.runtimeDetails).toEqual(["OpenCode", "Build", "High", "1 option"]);
  });

  it("includes a system prompt tag when configured", () => {
    const profile: AgentProfile = {
      id: "p3",
      name: "UI specialist",
      provider: "opencode",
      model: "openrouter/moonshotai/kimi-k3.1-pro",
      systemPrompt: "Focus on layout and tokens.",
    };

    const summary = buildAgentProfileRosterSummary({
      profile,
      entries,
      formatFeatureCount,
      systemPromptLabel: "System prompt",
    });

    expect(summary.runtimeDetails).toEqual(["OpenCode", "System prompt"]);
  });

  it("falls back to stored provider id when catalog is unavailable", () => {
    const profile: AgentProfile = {
      id: "p2",
      name: "Offline profile",
      provider: "custom-agent",
    };

    const summary = buildAgentProfileRosterSummary({
      profile,
      entries: undefined,
      formatFeatureCount,
    });

    expect(summary.providerLabel).toBe("custom-agent");
    expect(summary.modelLabel).toBeNull();
    expect(summary.runtimeDetails).toEqual(["custom-agent"]);
  });
});
