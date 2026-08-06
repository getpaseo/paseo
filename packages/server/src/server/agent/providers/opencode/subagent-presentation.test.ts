import { describe, expect, it } from "vitest";

import {
  buildOpenCodeSubagentSubtitle,
  claimOpenCodeSubagentFallbackTitle,
  foldOpenCodeSubagentPresentation,
  type OpenCodeSubagentPresentationState,
} from "./subagent-presentation.js";

describe("claimOpenCodeSubagentFallbackTitle", () => {
  it("claims the fallback title once", () => {
    const state: OpenCodeSubagentPresentationState = { facts: {} };

    expect(claimOpenCodeSubagentFallbackTitle(state, "explore")).toBe("explore");
    expect(claimOpenCodeSubagentFallbackTitle(state, "general")).toBeUndefined();
  });

  it("respects a title set by the tool-call link", () => {
    const state: OpenCodeSubagentPresentationState = { facts: {}, titleFromLink: true };

    expect(claimOpenCodeSubagentFallbackTitle(state, "general")).toBeUndefined();
  });

  it("rejects blank agent names", () => {
    const state: OpenCodeSubagentPresentationState = { facts: {} };

    expect(claimOpenCodeSubagentFallbackTitle(state, "   ")).toBeUndefined();
    expect(state.titleEmitted).toBeUndefined();
  });
});

describe("buildOpenCodeSubagentSubtitle", () => {
  it("formats OpenCode facts into one compact provider-owned label", () => {
    expect(
      buildOpenCodeSubagentSubtitle({
        agentName: "general",
        modelId: "claude-sonnet-5",
        variant: "high",
        totalTokens: 16_484,
      }),
    ).toBe("general · claude-sonnet-5 · High · 16.5k tokens");
  });

  it("keeps raw model ids visible without a label table", () => {
    expect(buildOpenCodeSubagentSubtitle({ modelId: "big-pickle" })).toBe("big-pickle");
  });

  it("capitalizes multi-word variants and maps xhigh", () => {
    expect(buildOpenCodeSubagentSubtitle({ variant: "ultra-think" })).toBe("Ultra Think");
    expect(buildOpenCodeSubagentSubtitle({ variant: "xhigh" })).toBe("Extra High");
  });

  it("formats token counts below one thousand without abbreviation", () => {
    expect(buildOpenCodeSubagentSubtitle({ totalTokens: 999 })).toBe("999 tokens");
  });

  it("omits facts that were not observed", () => {
    expect(buildOpenCodeSubagentSubtitle({ agentName: "explore", totalTokens: 0 })).toBe("explore");
    expect(buildOpenCodeSubagentSubtitle({})).toBeUndefined();
    expect(buildOpenCodeSubagentSubtitle({ agentName: "  " })).toBeUndefined();
  });
});

describe("foldOpenCodeSubagentPresentation", () => {
  it("returns the subtitle only when it changes", () => {
    const state: OpenCodeSubagentPresentationState = { facts: {} };
    expect(foldOpenCodeSubagentPresentation(state, { agentName: "general" })).toBe("general");
    expect(foldOpenCodeSubagentPresentation(state, { agentName: "general" })).toBeUndefined();
    expect(
      foldOpenCodeSubagentPresentation(state, { modelId: "claude-sonnet-5", totalTokens: 1_200 }),
    ).toBe("general · claude-sonnet-5 · 1.2k tokens");
    expect(foldOpenCodeSubagentPresentation(state, { totalTokens: 1_200 })).toBeUndefined();
  });

  it("returns undefined while no facts are known", () => {
    const state: OpenCodeSubagentPresentationState = { facts: {} };
    expect(foldOpenCodeSubagentPresentation(state, {})).toBeUndefined();
    expect(state.lastSubtitle).toBeUndefined();
  });
});
