// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
  Alert: { alert: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/styles/settings", () => ({ settingsStyles: {} }));

vi.mock("@/components/settings/headings/settings-section", () => ({
  SettingsSection: ({ title, children }: { title: string; children?: React.ReactNode }) =>
    React.createElement("section", { "aria-label": title }, children),
}));

vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: ({
    options,
    value,
    onValueChange,
  }: {
    options: { value: string; label: string }[];
    value: string;
    onValueChange: (value: string) => void;
  }) =>
    React.createElement(
      "div",
      { "data-value": value, "data-testid": "mode" },
      options.map((option) =>
        React.createElement(
          "button",
          { key: option.value, type: "button", onClick: () => onValueChange(option.value) },
          option.value,
        ),
      ),
    ),
}));

vi.mock("@/components/combined-model-selector", () => ({
  CombinedModelSelector: ({
    selectedModel,
    onSelect,
  }: {
    selectedModel: string;
    onSelect: (provider: string, model: string) => void;
  }) =>
    React.createElement(
      "button",
      {
        "data-testid": "selector",
        type: "button",
        onClick: () => onSelect("codex-auto", "gpt-6-astra"),
      },
      selectedModel || "none",
    ),
}));

import { SuggestionModelSection } from "./suggestion-model-section";

const SHARED = [{ provider: "claude-auto", model: "haiku" }];

function metadata(
  overrides: Partial<MutableDaemonConfig["metadataGeneration"]> = {},
): MutableDaemonConfig["metadataGeneration"] {
  return { providers: SHARED, ...overrides } as MutableDaemonConfig["metadataGeneration"];
}

const snapshot = {
  isLoading: false,
  isFetching: false,
  isRefreshing: false,
  refetchIfStale: vi.fn(),
  refresh: vi.fn(),
} as never;

describe("SuggestionModelSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  const patchConfig = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.stubGlobal("React", React);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    patchConfig.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(config: MutableDaemonConfig["metadataGeneration"]) {
    act(() => {
      root.render(
        <SuggestionModelSection
          serverId="s1"
          metadataGeneration={config}
          patchConfig={patchConfig}
          providers={[]}
          snapshot={snapshot}
        />,
      );
    });
  }

  function click(element: Element | null | undefined) {
    act(() => {
      element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function modeButton(value: string) {
    return [...container.querySelectorAll("button")].find((b) => b.textContent === value);
  }

  it("follows the shared model when no suggestion model is set", () => {
    render(metadata({ promptSuggestions: { providers: [] } }));
    expect(container.querySelector("[data-testid=mode]")?.getAttribute("data-value")).toBe(
      "shared",
    );
    expect(container.querySelector("[data-testid=selector]")).toBeNull();
  });

  it("saves the picked model for every suggestion kind and keeps the shared list", async () => {
    render(metadata());
    click(modeButton("custom"));
    click(container.querySelector("[data-testid=selector]"));
    await act(async () => {});

    const entries = [{ provider: "codex-auto", model: "gpt-6-astra" }];
    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(patchConfig).toHaveBeenCalledWith({
      metadataGeneration: {
        providers: SHARED,
        promptSuggestions: { providers: entries },
        newChatSuggestions: { providers: entries },
      },
    });
  });

  it("empties both per-kind lists when switched back to the shared model", async () => {
    const entries = [{ provider: "codex-auto", model: "gpt-6-astra" }];
    render(metadata({ promptSuggestions: { providers: entries } }));
    expect(container.querySelector("[data-testid=selector]")?.textContent).toBe("gpt-6-astra");

    click(modeButton("shared"));
    await act(async () => {});

    expect(patchConfig).toHaveBeenCalledWith({
      metadataGeneration: {
        providers: SHARED,
        promptSuggestions: { providers: [] },
        newChatSuggestions: { providers: [] },
      },
    });
  });

  it("keeps the fallback models when the first choice changes", async () => {
    const fallback = { provider: "opencode", model: "gpt-5.6-luna" };
    render(
      metadata({
        promptSuggestions: { providers: [{ provider: "claude-auto", model: "sonnet" }, fallback] },
      }),
    );
    click(container.querySelector("[data-testid=selector]"));
    await act(async () => {});

    const entries = [{ provider: "codex-auto", model: "gpt-6-astra" }, fallback];
    expect(patchConfig).toHaveBeenCalledWith({
      metadataGeneration: {
        providers: SHARED,
        promptSuggestions: { providers: entries },
        newChatSuggestions: { providers: entries },
      },
    });
  });
});
