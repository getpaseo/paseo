import { describe, expect, it } from "vitest";
import type {
  ProviderSelectionModelRow,
  ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { resolveInitialModelBrowserView, resolveModelBrowserAllView } from "./model-browser-view";

function provider(
  id: string,
  label: string,
  rows: ProviderSelectionModelRow[] = [],
): ProviderSelectorProvider {
  return {
    id,
    label,
    modelSelection: { kind: "models", rows },
  };
}

function modelRow(
  providerId: string,
  providerLabel: string,
  modelId: string,
  modelLabel: string,
): ProviderSelectionModelRow {
  return {
    favoriteKey: `${providerId}:${modelId}`,
    provider: providerId,
    providerLabel,
    modelId,
    modelLabel,
    description: modelId,
  };
}

describe("model browser initial view", () => {
  const codex = provider("codex", "Codex");
  const pi = provider("pi", "Pi");

  it("opens a sole provider directly", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [pi],
        selectedProvider: "",
        selectedModel: "",
        hasProfiles: false,
      }),
    ).toEqual({ kind: "provider", providerId: "pi", providerLabel: "Pi" });
  });

  it("opens the selected provider when there is one", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [codex, pi],
        selectedProvider: "pi",
        selectedModel: "pi-pro",
        hasProfiles: false,
      }),
    ).toEqual({ kind: "provider", providerId: "pi", providerLabel: "Pi" });
  });

  it("opens the root so pinned profiles are reachable", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [codex, pi],
        selectedProvider: "pi",
        selectedModel: "pi-pro",
        hasProfiles: true,
      }),
    ).toEqual({ kind: "all" });
  });

  it("opens a sole provider directly regardless of root content", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [pi],
        selectedProvider: "pi",
        selectedModel: "pi-pro",
        hasProfiles: true,
      }),
    ).toEqual({ kind: "provider", providerId: "pi", providerLabel: "Pi" });
  });

  it("falls back to the root when the selected provider is gone", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [codex, pi],
        selectedProvider: "gemini",
        selectedModel: "gemini-3",
        hasProfiles: false,
      }),
    ).toEqual({ kind: "all" });
  });
});

describe("model browser all view", () => {
  const claude = provider("claude", "Claude Code", [
    modelRow("claude", "Claude Code", "opus-5", "Opus 5"),
    modelRow("claude", "Claude Code", "sonnet-4.6", "Sonnet 4.6"),
  ]);
  const copilot = provider("copilot", "Copilot", [
    modelRow("copilot", "Copilot", "claude-opus-5", "Opus 5"),
  ]);
  const codex = provider("codex", "Codex", [modelRow("codex", "Codex", "gpt-5.4", "GPT-5.4")]);
  const providers = [claude, copilot, codex];

  it("browses providers while the query is empty", () => {
    expect(resolveModelBrowserAllView({ providers, normalizedQuery: "" })).toEqual({
      kind: "browse",
    });
  });

  it("ranks the same model label across every provider that offers it", () => {
    const view = resolveModelBrowserAllView({ providers, normalizedQuery: "opus" });

    expect(view.kind).toBe("searchResults");
    expect(view.kind === "searchResults" ? view.rows.map((row) => row.favoriteKey) : []).toEqual([
      "claude:opus-5",
      "copilot:claude-opus-5",
    ]);
  });

  it("matches models by their provider label", () => {
    const view = resolveModelBrowserAllView({ providers, normalizedQuery: "codex" });

    expect(view.kind === "searchResults" ? view.rows.map((row) => row.modelId) : []).toEqual([
      "gpt-5.4",
    ]);
  });

  it("reports no matches instead of falling back to the provider list", () => {
    expect(resolveModelBrowserAllView({ providers, normalizedQuery: "zzzz" })).toEqual({
      kind: "noSearchMatches",
    });
  });

  it("ignores providers that are still loading or errored", () => {
    const loading: ProviderSelectorProvider = {
      id: "opencode",
      label: "OpenCode",
      modelSelection: { kind: "loading" },
    };
    const failed: ProviderSelectorProvider = {
      id: "pi",
      label: "Pi",
      modelSelection: { kind: "error", message: "unavailable" },
    };

    expect(
      resolveModelBrowserAllView({ providers: [loading, failed], normalizedQuery: "opus" }),
    ).toEqual({ kind: "noSearchMatches" });
  });
});
