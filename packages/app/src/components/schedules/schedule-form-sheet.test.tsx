/**
 * @vitest-environment jsdom
 */
import React, { act, type ReactNode, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleFormSheet } from "./schedule-form-sheet";
import type { ScheduleFormState } from "@/schedules/schedule-form-model";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6, lg: 8 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      border: "#444",
      borderAccent: "#555",
      accent: "#8ab4f8",
      palette: { red: { 300: "#f87171" } },
    },
    opacity: { 50: 0.5 },
  },
}));

vi.mock("react-native", () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
}));

vi.mock("lucide-react-native", () => ({
  Brain: () => null,
  Folder: () => null,
  GitBranch: () => null,
}));

vi.mock("zustand/traditional", () => ({
  useStoreWithEqualityFn: () => [
    { serverId: "server-1", label: "Host 1", supportsWorkspaceMultiplicity: true },
  ],
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    visible,
    children,
    footer,
    onClose,
    onDismiss,
    testID,
  }: {
    visible: boolean;
    children?: ReactNode;
    footer?: ReactNode;
    onClose: () => void;
    onDismiss?: () => void;
    testID?: string;
  }) =>
    visible
      ? React.createElement(
          "section",
          { "data-testid": testID },
          React.createElement(
            "button",
            {
              type: "button",
              "data-testid": "adaptive-modal-close",
              onClick: onClose,
            },
            "Close",
          ),
          React.createElement(
            "button",
            {
              type: "button",
              "data-testid": "adaptive-modal-dismiss",
              onClick: onDismiss,
            },
            "Dismiss",
          ),
          children,
          footer,
        )
      : null,
}));

vi.mock("@/components/ui/combobox", () => ({
  ComboboxItem: ({ label }: { label: string }) => React.createElement("span", null, label),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onPress,
    testID,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        disabled,
        "data-testid": testID,
        onClick: () => {
          if (!disabled) {
            onPress?.();
          }
        },
      },
      children,
    ),
}));

vi.mock("@/components/combined-model-selector", () => ({
  CombinedModelSelector: () => React.createElement("div", null),
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/components/hosts/host-picker", () => ({
  HostStatusDotSlot: () => null,
}));

vi.mock("@/components/ui/control-geometry", () => ({
  createControlGeometry: () => ({
    formTextInputSm: {},
    formTextInputMd: {},
  }),
}));

vi.mock("@/components/ui/form-field", () => ({
  Field: ({ children }: { children?: ReactNode }) => React.createElement("div", null, children),
  FormTextInput: ({ testID }: { testID?: string }) =>
    React.createElement("input", { "data-testid": testID }),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: () => React.createElement("button", { type: "button" }),
}));

vi.mock("@/components/provider-icons", () => ({
  getProviderIcon: () => () => null,
}));

vi.mock("@/components/schedules/cadence-editor", () => ({
  CadenceEditor: () => React.createElement("div", null),
}));

vi.mock("@/components/ui/select-field", () => ({
  SelectField: () => React.createElement("div", null),
  SelectFieldTrigger: ({ label }: { label: string }) =>
    React.createElement("button", { type: "button" }, label),
}));

vi.mock("@/hooks/use-form-preferences", () => ({
  mergeProviderPreferences: ({ preferences }: { preferences: Record<string, unknown> }) =>
    preferences,
  useFormPreferences: () => ({
    preferences: {},
    updatePreferences: async () => {},
  }),
}));

vi.mock("@/hooks/use-schedule-mutations", () => ({
  useScheduleMutations: () => ({
    createSchedule: async () => {},
    updateSchedule: async () => {},
    isCreating: false,
    isUpdating: false,
  }),
}));

vi.mock("@/hooks/use-aggregated-agents", () => ({
  useAggregatedAgents: () => ({ agents: [] }),
}));

vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({ projects: [] }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "server-1", label: "Host 1" }],
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: {},
}));

const fakeState: ScheduleFormState = {
  mode: "create",
  targetKind: "new-agent",
  name: "",
  prompt: "",
  maxRuns: "",
  cadence: { type: "every", everyMs: 60_000 },
  hosts: [{ serverId: "server-1", label: "Host 1", supportsWorkspaceMultiplicity: true }],
  projectOptions: [],
  selectedServerId: "server-1",
  selectedProvider: null,
  selectedModel: "",
  selectedMode: "",
  selectedThinkingOptionId: "",
  workingDir: "",
  projectDisplay: null,
  selectedProjectOptionId: "",
  selectedModelDisplay: null,
  selectedModeDisplay: { label: "Default mode" },
  selectedThinkingDisplay: null,
  modelSelectorProviders: [],
  modeOptions: [],
  availableThinkingOptions: [],
  archiveOnFinish: true,
  isolation: "local",
  effectiveIsolation: "local",
  canUseWorktreeIsolation: false,
  providerResolutionByServerId: {},
  providerSnapshotRequest: null,
  disclosure: {
    showProjectField: false,
    showModelField: false,
    showThinkingField: false,
    showModeField: false,
    showIsolationField: false,
    showArchiveOnFinishField: false,
  },
  canSubmit: false,
  submitError: null,
};

vi.mock("@/schedules/use-schedule-form-model", () => ({
  useScheduleFormModel: () => ({
    getState: () => fakeState,
    subscribe: () => () => {},
    close: () => {},
    applyHosts: () => {},
    applyProjectTargets: () => {},
    applyProviderSnapshot: () => {},
    setHost: () => {},
    setProject: () => {},
    setModel: () => {},
    setThinking: () => {},
    setSessionMode: () => {},
    setName: () => {},
    setPrompt: () => {},
    setMaxRuns: () => {},
    setCadence: () => {},
    setIsolation: () => {},
    setArchiveOnFinish: () => {},
    setSubmitError: () => {},
  }),
}));

vi.mock("@/schedules/use-schedule-form-provider-snapshot", () => ({
  useScheduleFormProviderSnapshot: () => ({
    isLoading: false,
    isFetching: false,
    isRefreshing: false,
    refresh: async () => {},
    refetchIfStale: () => {},
  }),
}));

vi.mock("@/utils/device-timezone", () => ({
  getDeviceTimeZone: () => "UTC",
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function querySheet(): Element | null {
  return document.querySelector('[data-testid="schedule-form-sheet"]');
}

function click(testID: string): void {
  const element = document.querySelector(`[data-testid="${testID}"]`);
  if (!element) {
    throw new Error(`Missing ${testID}`);
  }
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function renderParent(onClose: () => void): void {
  function Parent() {
    const [visible, setVisible] = useState(true);
    const handleClose = useCallback(() => {
      onClose();
      setVisible(false);
    }, []);

    return (
      <ScheduleFormSheet
        serverId="server-1"
        visible={visible}
        onClose={handleClose}
        mode="create"
      />
    );
  }

  act(() => {
    root?.render(<Parent />);
  });
}

describe("ScheduleFormSheet dismissal", () => {
  it("notifies the parent once when the sheet is dismissed directly", () => {
    const onClose = vi.fn();
    renderParent(onClose);
    expect(querySheet()).not.toBeNull();

    click("adaptive-modal-dismiss");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(querySheet()).toBeNull();
  });
});
