/** @vitest-environment jsdom */
import React, { act, useCallback, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

const { state, patchConfig } = vi.hoisted(() => ({
  state: {
    config: null as MutableDaemonConfig | null,
    isLoading: false,
    entries: [] as ProviderSnapshotEntry[],
  },
  patchConfig: vi.fn<() => Promise<MutableDaemonConfig | undefined>>(),
}));

interface ContainerProps {
  children?: ReactNode;
  testID?: string;
}
function Container({ children, testID }: ContainerProps) {
  return <div data-testid={testID}>{children}</div>;
}
vi.mock("react-native", () => ({
  View: (props: ContainerProps) => <Container {...props} />,
  Text: ({ children }: ContainerProps) => <span>{children}</span>,
}));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({}) } }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({ ...state, patchConfig }),
}));
vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: state.entries,
    isLoading: false,
    isFetching: false,
    isRefreshing: false,
    refetchIfStale: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock("@/agent-profiles", () => ({ useAgentProfiles: () => ({ profiles: [] }) }));
vi.mock("@/components/settings", () => ({
  SettingsSection: (props: ContainerProps) => <Container {...props} />,
  SettingsCard: (props: ContainerProps) => <Container {...props} />,
  SettingsRow: (props: ContainerProps) => <Container {...props} />,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    testID,
    onPress,
    disabled,
  }: ContainerProps & {
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" data-testid={testID} onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    children,
    testID,
    footer,
    onClose,
  }: ContainerProps & {
    footer?: ReactNode;
    onClose: () => void;
  }) => (
    <div data-testid={testID}>
      <button type="button" data-testid="cancel" onClick={onClose}>
        Cancel
      </button>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock("@/components/settings-textarea", () => ({
  SettingsTextAreaCard: ({
    value,
    testID,
    onChangeText,
  }: {
    value: string;
    testID: string;
    onChangeText: (value: string) => void;
  }) => {
    const handleChange = useCallback(
      (event: React.ChangeEvent<HTMLTextAreaElement>) => onChangeText(event.target.value),
      [onChangeText],
    );
    return <textarea data-testid={testID} value={value} onChange={handleChange} />;
  },
}));
vi.mock("@/components/combined-model-selector", () => ({
  CombinedModelSelector: ({
    selectedProvider,
    selectedModel,
    disabled,
    onSelect,
  }: {
    selectedProvider: string;
    selectedModel: string;
    disabled: boolean;
    onSelect: (provider: string, model: string) => void;
  }) => {
    const handleSelect = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        const { provider, model } = event.currentTarget.dataset;
        if (provider && model) onSelect(provider, model);
      },
      [onSelect],
    );
    return (
      <div data-selection={`${selectedProvider}/${selectedModel}`}>
        {state.entries.flatMap((entry) =>
          entry.models?.map((model) => (
            <button
              type="button"
              key={model.id}
              data-model={model.id}
              data-provider={entry.provider}
              disabled={disabled}
              onClick={handleSelect}
            >
              {model.label}
            </button>
          )),
        )}
      </div>
    );
  },
}));
vi.mock("@/components/ui/select-field", () => ({
  SelectField: ({
    value,
    options,
    onChange,
    disabled,
    testID,
  }: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    disabled: boolean;
    testID: string;
  }) => {
    const handleChange = useCallback(
      (event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.target.value),
      [onChange],
    );
    return (
      <select data-testid={testID} value={value} disabled={disabled} onChange={handleChange}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  },
}));

import { WorkspaceGitWorkflowSettingsSection } from "./settings";

const prefix = "workspace-git-workflow-";

function providerFixture(provider: string): ProviderSnapshotEntry {
  return {
    provider,
    enabled: true,
    status: "ready",
    label: provider,
    description: provider,
    defaultModeId: null,
    modes: [],
    models: ["review", "commit", "pr"].map((name) => ({
      provider,
      id: `${provider}-${name}`,
      label: `${provider} ${name}`,
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    })),
  };
}

describe("WorkspaceGitWorkflowSettingsSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    state.config = {
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
      workspaceGitWorkflow: {
        reviewProfileId: "legacy-review",
        deliveryProfileId: "legacy-pr",
        reviewPrompt: "Preserve this prompt.",
      },
    };
    state.isLoading = false;
    state.entries = ["codex", "claude"].map(providerFixture);
    patchConfig.mockReset().mockResolvedValue(state.config);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  function render() {
    act(() => root.render(<WorkspaceGitWorkflowSettingsSection serverId="host-1" />));
  }
  function element(selector: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`Missing ${selector}`);
    return found;
  }
  async function click(selector: string) {
    await act(async () => element(selector).click());
  }
  function byId(id: string) {
    return `[data-testid="${id}"]`;
  }
  function sheet() {
    return container.querySelector(byId(`${prefix}settings-sheet`));
  }
  async function choose(key: string, model: string) {
    await click(`${byId(prefix + key)} [data-model="${model}"]`);
  }
  function selected(key: string) {
    return element(`${byId(prefix + key)} [data-selection]`).getAttribute("data-selection");
  }

  it("saves independent review, commit and PR models with effort and preserves profiles/prompts", async () => {
    render();
    await click(byId(prefix + "edit"));
    await choose("reviewModel", "codex-review");
    await choose("commitModel", "codex-commit");
    await choose("prModel", "claude-pr");
    await act(async () => {
      const effort = element(byId(prefix + "reviewModel-thinking")) as HTMLSelectElement;
      effort.value = "high";
      effort.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(byId(prefix + "save"));
    expect(patchConfig).toHaveBeenCalledExactlyOnceWith({
      workspaceGitWorkflow: {
        reviewProfileId: "legacy-review",
        deliveryProfileId: "legacy-pr",
        reviewPrompt: "Preserve this prompt.",
        createPrPrompt: "",
        commitAndPushPrompt: "",
        reviewModel: { provider: "codex", model: "codex-review", thinkingOptionId: "high" },
        commitModel: { provider: "codex", model: "codex-commit" },
        prModel: { provider: "claude", model: "claude-pr" },
      },
    });
    expect(sheet()).toBeNull();
  });

  it("discards cancelled edits and reopens the saved values", async () => {
    render();
    await click(byId(prefix + "edit"));
    await choose("reviewModel", "codex-review");
    await click(byId("cancel"));
    expect(sheet()).toBeNull();
    expect(patchConfig).not.toHaveBeenCalled();
    await click(byId(prefix + "edit"));
    expect(selected("reviewModel")).toBe("/");
  });

  it.each(["undefined", "error"])(
    "keeps edits visible and retryable after a %s save result",
    async (outcome) => {
      if (outcome === "undefined") patchConfig.mockResolvedValueOnce(undefined);
      else patchConfig.mockRejectedValueOnce(new Error("Storage failed"));
      render();
      await click(byId(prefix + "edit"));
      await choose("commitModel", "codex-commit");
      await click(byId(prefix + "save"));
      expect(sheet()).not.toBeNull();
      expect(selected("commitModel")).toBe("codex/codex-commit");
      expect(container.textContent).toContain(
        outcome === "undefined" ? "workspace.git.workflow.saveFailed" : "Storage failed",
      );
      await click(byId(prefix + "save"));
      expect(patchConfig).toHaveBeenCalledTimes(2);
      expect(sheet()).toBeNull();
    },
  );

  it.each(["loading", "missing"])(
    "prevents editing when configuration is %s",
    async (condition) => {
      state.isLoading = condition === "loading";
      if (condition === "missing") state.config = null;
      render();
      expect((element(byId(prefix + "edit")) as HTMLButtonElement).disabled).toBe(true);
      await click(byId(prefix + "edit"));
      expect(sheet()).toBeNull();
      expect(patchConfig).not.toHaveBeenCalled();
    },
  );
});
