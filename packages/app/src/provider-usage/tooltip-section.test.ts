import type { ProviderUsage } from "./types";
import { matchProviderUsage } from "./tooltip-match";
import { describe, expect, it } from "vitest";

const providers: ProviderUsage[] = [
  {
    providerId: "claude",
    displayName: "Claude",
    status: "available",
    planLabel: "Pro",
    windows: [],
  },
  {
    providerId: "zai",
    displayName: "Z.ai",
    status: "available",
    planLabel: "lite",
    windows: [],
  },
  {
    providerId: "opencode-go",
    displayName: "OpenCode Go",
    status: "available",
    planLabel: "OpenCode Go",
    windows: [],
  },
  {
    providerId: "codex",
    displayName: "Codex",
    status: "available",
    planLabel: "ChatGPT Plus",
    windows: [],
  },
];

describe("matchProviderUsage", () => {
  it("matches ordinary agents by their Paseo provider", () => {
    expect(matchProviderUsage(providers, "claude")).toMatchObject({ providerId: "claude" });
  });

  it("matches OMP agents by their active model-provider prefix", () => {
    expect(matchProviderUsage(providers, "omp", "zai")).toMatchObject({ providerId: "zai" });
    expect(matchProviderUsage(providers, "pi", "opencode-go")).toMatchObject({
      providerId: "opencode-go",
    });
  });

  it("maps the OMP OpenAI model provider to Codex usage", () => {
    expect(matchProviderUsage(providers, "omp", "openai-codex")).toMatchObject({
      providerId: "codex",
      planLabel: "ChatGPT Plus",
    });
  });

  it("does not show a subscription when the OMP model has no known provider usage", () => {
    expect(matchProviderUsage(providers, "omp", "openrouter")).toBeNull();
    expect(matchProviderUsage(providers, "pi")).toBeNull();
  });
});
