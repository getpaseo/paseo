import { describe, expect, it } from "vitest";
import { resolveProviderUsage } from "./resolve";
import type { ProviderUsage } from "./types";

function usage(providerId: string, displayName = providerId): ProviderUsage {
  return {
    providerId,
    displayName,
    status: "available",
    planLabel: null,
    windows: [],
    balances: [],
    details: [],
    error: null,
  };
}

const SYNTHETIC = usage("synthetic", "Synthetic");
const CODEX = usage("codex", "Codex");

describe("resolveProviderUsage", () => {
  it("matches the active agent provider id exactly", () => {
    expect(resolveProviderUsage([CODEX], "codex", "gpt-5.2-codex")).toBe(CODEX);
  });

  it("falls back to the model's upstream prefix for a distinct Paseo provider", () => {
    expect(
      resolveProviderUsage(
        [SYNTHETIC],
        "opencode-rest",
        "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash",
      ),
    ).toBe(SYNTHETIC);
  });

  it("matches the built-in opencode provider through the model prefix", () => {
    expect(resolveProviderUsage([SYNTHETIC], "opencode", "synthetic/hf:moonshotai/Kimi-K3")).toBe(
      SYNTHETIC,
    );
  });

  it("matches case-insensitively", () => {
    expect(resolveProviderUsage([SYNTHETIC], "OpenCode-ACP", "Synthetic/model")).toBe(SYNTHETIC);
  });

  it("prefers the provider id over the model prefix", () => {
    expect(resolveProviderUsage([SYNTHETIC, CODEX], "codex", "synthetic/model")).toBe(CODEX);
  });

  it("ignores a model without an upstream prefix", () => {
    expect(resolveProviderUsage([SYNTHETIC], "opencode", "deepseek-v4")).toBeNull();
    expect(resolveProviderUsage([SYNTHETIC], "opencode", "/leading-slash")).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(resolveProviderUsage([SYNTHETIC], "opencode", "anthropic/claude")).toBeNull();
  });

  it("returns null without any candidate", () => {
    expect(resolveProviderUsage([SYNTHETIC], null, null)).toBeNull();
    expect(resolveProviderUsage([SYNTHETIC], "   ", "")).toBeNull();
  });
});
