import { describe, expect, it } from "vitest";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { resolveInitialModelBrowserView } from "./model-browser-view";

function provider(id: string, label: string): ProviderSelectorProvider {
  return {
    id,
    label,
    modelSelection: { kind: "models", rows: [] },
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
        favoriteKeys: new Set(),
      }),
    ).toEqual({ kind: "provider", providerId: "pi", providerLabel: "Pi" });
  });

  it("opens the selected provider when its model is not a favorite", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [codex, pi],
        selectedProvider: "pi",
        selectedModel: "pi-pro",
        favoriteKeys: new Set(),
      }),
    ).toEqual({ kind: "provider", providerId: "pi", providerLabel: "Pi" });
  });

  it("opens the provider overview when the selected model is a favorite", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [codex, pi],
        selectedProvider: "pi",
        selectedModel: "pi-pro",
        favoriteKeys: new Set(["pi:pi-pro"]),
      }),
    ).toEqual({ kind: "all" });
  });
});
