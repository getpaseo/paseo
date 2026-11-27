import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import {
  materializeAgentProfile,
  reconcileMaterializedProfileMode,
  toAgentConfigApply,
} from "./materialize-profile";

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "ui-work",
    name: "UI work",
    provider: "claude",
    ...overrides,
  };
}

describe("materializeAgentProfile", () => {
  it("resolves every field a full profile names", () => {
    expect(
      materializeAgentProfile(
        profile({
          model: "claude-opus-5",
          modeId: "plan",
          thinkingOptionId: "think-hard",
          options: { web_search: true },
          systemPrompt: "  Focus on UI tokens.  ",
        }),
      ),
    ).toEqual({
      provider: "claude",
      modelId: "claude-opus-5",
      modeId: "plan",
      thinkingOptionId: "think-hard",
      options: { web_search: true },
      systemPrompt: "Focus on UI tokens.",
    });
  });

  it("treats omitted and blank fields the same", () => {
    expect(
      materializeAgentProfile(profile({ model: "   ", modeId: "", systemPrompt: "   " })),
    ).toEqual({
      provider: "claude",
      modelId: "",
      modeId: "",
      thinkingOptionId: "",
      options: {},
      systemPrompt: "",
    });
  });

  it("trims stored ids", () => {
    expect(materializeAgentProfile(profile({ model: " claude-opus-5 " })).modelId).toBe(
      "claude-opus-5",
    );
  });
});

describe("toAgentConfigApply", () => {
  it("sends every value the profile names", () => {
    expect(
      toAgentConfigApply(
        materializeAgentProfile(
          profile({
            model: "claude-opus-5",
            modeId: "plan",
            thinkingOptionId: "think-hard",
            options: { web_search: true },
          }),
        ),
      ),
    ).toEqual({
      modelId: "claude-opus-5",
      modeId: "plan",
      thinkingOptionId: "think-hard",
      options: { web_search: true },
    });
  });

  it("omits what the profile leaves alone rather than clearing it", () => {
    expect(toAgentConfigApply(materializeAgentProfile(profile({ modeId: "plan" })))).toEqual({
      modeId: "plan",
    });
  });

  it("omits an empty feature map so the agent keeps its own feature values", () => {
    expect(
      toAgentConfigApply(materializeAgentProfile(profile({ options: {} }))),
    ).not.toHaveProperty("options");
  });

  it("never carries provider or systemPrompt, which a running agent cannot change", () => {
    const applied = toAgentConfigApply(
      materializeAgentProfile(
        profile({ model: "claude-opus-5", systemPrompt: "Focus on UI tokens." }),
      ),
    );
    expect(applied).not.toHaveProperty("provider");
    expect(applied).not.toHaveProperty("systemPrompt");
  });
});

describe("reconcileMaterializedProfileMode", () => {
  it("waits when the current provider mode catalog is unknown", () => {
    expect(
      reconcileMaterializedProfileMode(materializeAgentProfile(profile({ modeId: "plan" })), null),
    ).toBeNull();
  });

  it("drops a profile mode removed from the current provider catalog", () => {
    expect(
      reconcileMaterializedProfileMode(
        materializeAgentProfile(profile({ modeId: "removed-mode" })),
        ["plan", "default"],
      ),
    ).toMatchObject({ modeId: "" });
  });

  it("preserves a profile mode still offered by the provider", () => {
    expect(
      reconcileMaterializedProfileMode(materializeAgentProfile(profile({ modeId: "plan" })), [
        "plan",
        "default",
      ]),
    ).toMatchObject({ modeId: "plan" });
  });
});
