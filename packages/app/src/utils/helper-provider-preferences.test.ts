import { describe, expect, it } from "vitest";

import {
  normalizeHelperProviderPreferences,
  resolveHelperProviderPreferences,
} from "./helper-provider-preferences";

describe("helper-provider-preferences", () => {
  it("filters invalid and duplicate saved helper providers", () => {
    expect(
      normalizeHelperProviderPreferences([
        { provider: "codex", model: "gpt-5.4-mini" },
        { provider: "codex", model: "ignored" },
        { provider: "claude", model: "" },
        { provider: "", model: "bad" },
        null,
      ]),
    ).toEqual([
      { provider: "codex", model: "gpt-5.4-mini" },
      { provider: "claude", model: null },
    ]);
  });

  it("keeps helper order within currently ready providers and appends new ones", () => {
    expect(
      resolveHelperProviderPreferences({
        entries: [
          {
            provider: "codex",
            status: "ready",
            models: [{ provider: "codex", id: "gpt-5.4-mini", label: "GPT-5.4 Mini" }],
          },
          {
            provider: "claude",
            status: "ready",
            models: [{ provider: "claude", id: "haiku", label: "Haiku" }],
          },
          {
            provider: "opencode",
            status: "error",
          },
        ],
        savedPreferences: [
          { provider: "claude", model: "haiku" },
          { provider: "opencode", model: "opencode/gpt-5-nano" },
        ],
      }),
    ).toEqual([
      { provider: "claude", model: "haiku" },
      { provider: "codex", model: null },
    ]);
  });

  it("drops saved models that no longer exist for a ready provider", () => {
    expect(
      resolveHelperProviderPreferences({
        entries: [
          {
            provider: "codex",
            status: "ready",
            models: [{ provider: "codex", id: "gpt-5.4", label: "GPT-5.4" }],
          },
        ],
        savedPreferences: [{ provider: "codex", model: "gpt-5.4-mini" }],
      }),
    ).toEqual([{ provider: "codex", model: null }]);
  });

  it("falls back to saved preferences when no provider snapshot is available", () => {
    expect(
      resolveHelperProviderPreferences({
        entries: undefined,
        savedPreferences: [{ provider: "codex", model: "gpt-5.4-mini" }],
      }),
    ).toEqual([{ provider: "codex", model: "gpt-5.4-mini" }]);
  });
});
