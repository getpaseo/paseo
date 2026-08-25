import { describe, expect, it } from "vitest";

import {
  buildOpenCodeV2SubagentSubtitle,
  claimOpenCodeV2SubagentFallbackTitle,
  foldOpenCodeV2SubagentPresentation,
  type OpenCodeV2SubagentPresentationState,
} from "./subagent-presentation.js";

describe("claimOpenCodeV2SubagentFallbackTitle", () => {
  it("claims the fallback title once", () => {
    const state: OpenCodeV2SubagentPresentationState = { facts: {} };

    expect(claimOpenCodeV2SubagentFallbackTitle(state, "explore")).toBe("explore");
    expect(claimOpenCodeV2SubagentFallbackTitle(state, "general")).toBeUndefined();
  });

  it("respects a title set by the tool-call link", () => {
    const state: OpenCodeV2SubagentPresentationState = { facts: {}, titleFromLink: true };

    expect(claimOpenCodeV2SubagentFallbackTitle(state, "general")).toBeUndefined();
  });

  it("rejects blank agent names", () => {
    const state: OpenCodeV2SubagentPresentationState = { facts: {} };

    expect(claimOpenCodeV2SubagentFallbackTitle(state, "   ")).toBeUndefined();
    expect(state.titleEmitted).toBeUndefined();
  });
});

describe("buildOpenCodeV2SubagentSubtitle", () => {
  it("formats OpenCode 2 facts into one compact provider-owned label", () => {
    expect(
      buildOpenCodeV2SubagentSubtitle({
        agentName: "general",
        modelId: "deepseek-ai/DeepSeek-V4-Flash-0731",
        variant: "high",
        totalTokens: 16_484,
      }),
    ).toBe("general · deepseek-ai/DeepSeek-V4-Flash-0731 · High · 16.5k tokens");
  });

  it("keeps raw model ids visible without a label table", () => {
    expect(buildOpenCodeV2SubagentSubtitle({ modelId: "big-pickle" })).toBe("big-pickle");
  });

  it("capitalizes multi-word variants and maps xhigh", () => {
    expect(buildOpenCodeV2SubagentSubtitle({ variant: "ultra-think" })).toBe("Ultra Think");
    expect(buildOpenCodeV2SubagentSubtitle({ variant: "xhigh" })).toBe("Extra High");
  });

  it("formats token counts below one thousand without abbreviation", () => {
    expect(buildOpenCodeV2SubagentSubtitle({ totalTokens: 999 })).toBe("999 tokens");
  });

  it("omits facts that were not observed", () => {
    expect(buildOpenCodeV2SubagentSubtitle({ agentName: "explore", totalTokens: 0 })).toBe(
      "explore",
    );
    expect(buildOpenCodeV2SubagentSubtitle({})).toBeUndefined();
    expect(buildOpenCodeV2SubagentSubtitle({ agentName: "  " })).toBeUndefined();
  });
});

describe("foldOpenCodeV2SubagentPresentation", () => {
  it("returns the subtitle only when it changes", () => {
    const state: OpenCodeV2SubagentPresentationState = { facts: {} };
    expect(foldOpenCodeV2SubagentPresentation(state, { agentName: "general" })).toBe("general");
    expect(foldOpenCodeV2SubagentPresentation(state, { agentName: "general" })).toBeUndefined();
    expect(
      foldOpenCodeV2SubagentPresentation(state, {
        modelId: "deepseek-ai/DeepSeek-V4-Flash-0731",
        totalTokens: 1_200,
      }),
    ).toBe("general · deepseek-ai/DeepSeek-V4-Flash-0731 · 1.2k tokens");
    expect(foldOpenCodeV2SubagentPresentation(state, { totalTokens: 1_200 })).toBeUndefined();
  });

  it("returns undefined while no facts are known", () => {
    const state: OpenCodeV2SubagentPresentationState = { facts: {} };
    expect(foldOpenCodeV2SubagentPresentation(state, {})).toBeUndefined();
    expect(state.lastSubtitle).toBeUndefined();
  });
});
