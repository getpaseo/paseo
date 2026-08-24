import { describe, expect, it } from "vitest";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { resolveModelBrowserScrolling, resolveModelSheetOpening } from "./model-sheet-flow";

function provider(id: string, label: string): ProviderSelectorProvider {
  return { id, label, modelSelection: { kind: "models", rows: [] } };
}

const codex = provider("codex", "Codex");
const claude = provider("claude", "Claude Code");

describe("model sheet opening", () => {
  it("starts drafts at providers even when only one provider is available", () => {
    expect(
      resolveModelSheetOpening({
        canSwitchProvider: true,
        providers: [codex],
        selectedProvider: "codex",
      }),
    ).toEqual({ kind: "all" });
  });

  it("opens a running agent directly at its fixed provider", () => {
    expect(
      resolveModelSheetOpening({
        canSwitchProvider: false,
        providers: [claude, codex],
        selectedProvider: "codex",
      }),
    ).toEqual({ kind: "provider", providerId: "codex", providerLabel: "Codex" });
  });

  it("falls back to the only provider while live state catches up", () => {
    expect(
      resolveModelSheetOpening({
        canSwitchProvider: false,
        providers: [codex],
        selectedProvider: "",
      }),
    ).toEqual({ kind: "provider", providerId: "codex", providerLabel: "Codex" });
  });
});

describe("model sheet gesture ownership", () => {
  it("uses the sheet-aware model browser inside compact bottom sheets", () => {
    expect(resolveModelBrowserScrolling(true)).toBe("sheet");
  });

  it("keeps independent scrolling in the desktop split viewport", () => {
    expect(resolveModelBrowserScrolling(false)).toBe("independent");
  });
});
