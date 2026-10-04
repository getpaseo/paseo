import { describe, expect, it } from "vitest";
import { buildSuggestionModelPatch } from "./suggestion-model-patch";

describe("buildSuggestionModelPatch", () => {
  it("empties the suggestion list for Automatic", () => {
    expect(buildSuggestionModelPatch(null, [{ provider: "codex", model: "gpt-5.4" }])).toEqual({
      metadataGeneration: { promptSuggestions: { providers: [] } },
    });
  });

  it("puts the chosen model first and keeps the fallbacks after it", () => {
    const fallback = { provider: "claude", model: "sonnet" };
    expect(
      buildSuggestionModelPatch({ provider: "codex", model: "gpt-5.4-mini" }, [
        { provider: "codex", model: "gpt-5.4" },
        fallback,
      ]),
    ).toEqual({
      metadataGeneration: {
        promptSuggestions: {
          providers: [{ provider: "codex", model: "gpt-5.4-mini" }, fallback],
        },
      },
    });
  });

  it("saves a first choice when nothing was configured", () => {
    expect(buildSuggestionModelPatch({ provider: "codex", model: "gpt-5.4" }, undefined)).toEqual({
      metadataGeneration: {
        promptSuggestions: { providers: [{ provider: "codex", model: "gpt-5.4" }] },
      },
    });
  });

  it("leaves the model out when the provider's default is chosen", () => {
    expect(buildSuggestionModelPatch({ provider: "codex", model: "" }, [])).toEqual({
      metadataGeneration: { promptSuggestions: { providers: [{ provider: "codex" }] } },
    });
  });
});
