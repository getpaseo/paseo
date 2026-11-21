/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React, { type ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetadataGenerationPage } from "./metadata-generation-page";

void testI18n;

const { configState, patchConfigMock } = vi.hoisted(() => ({
  configState: { config: null as MutableDaemonConfig | null },
  patchConfigMock: vi.fn(async () => undefined),
}));

vi.mock("react-native-unistyles", async () => {
  const { darkTheme } = await import("@/styles/theme");
  return {
    StyleSheet: {
      create: (factory: unknown) =>
        typeof factory === "function" ? (factory as (t: unknown) => unknown)(darkTheme) : factory,
    },
    useUnistyles: () => ({ theme: darkTheme, rt: { breakpoint: "md" } }),
    withUnistyles: (comp: unknown) => comp,
  };
});

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: configState.config,
    isLoading: false,
    patchConfig: patchConfigMock,
  }),
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: [],
    isLoading: false,
    isFetching: false,
    isRefreshing: false,
    refetchIfStale: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  Keyframe: class {
    duration() {
      return this;
    }
  },
  Easing: { ease: "ease", inOut: (value: unknown) => value },
  interpolateColor: (value: number, _input: number[], output: string[]) =>
    value >= 1 ? output[1] : output[0],
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useDerivedValue: (factory: () => unknown) => ({ value: factory() }),
  withTiming: (value: unknown) => value,
}));

vi.mock("@gorhom/bottom-sheet", () => ({
  BottomSheetBackdrop: () => null,
  BottomSheetHandle: () => null,
  BottomSheetModal: React.forwardRef(() => null),
  BottomSheetScrollView: "div",
  BottomSheetTextInput: "input",
  useBottomSheetInternal: () => null,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock("@/components/combined-model-selector", () => ({
  CombinedModelSelector: () =>
    React.createElement("div", { "data-testid": "combined-model-selector" }),
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    header,
    children,
    onClose,
    testID,
  }: {
    header: { title: string };
    children: React.ReactNode;
    onClose(): void;
    testID?: string;
  }) =>
    React.createElement(
      "div",
      { role: "dialog", "data-testid": testID },
      React.createElement("h2", null, header.title),
      React.createElement("button", { type: "button", onClick: onClose }, "Close"),
      children,
    ),
}));

function renderPage(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("MetadataGenerationPage", () => {
  beforeEach(() => {
    patchConfigMock.mockClear();
    configState.config = {
      relay: { enabled: false },
      mcp: { injectIntoAgents: true },
      browserTools: { enabled: false },
      providers: {},
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
      metadataGeneration: {
        providers: [],
      },
    } as unknown as MutableDaemonConfig;
  });

  afterEach(() => {
    cleanup();
  });

  it("renders metadata model selection and prompt instruction rows with defaults", () => {
    renderPage(<MetadataGenerationPage serverId="local" />);

    expect(screen.getByTestId("metadata-generation-settings")).toBeTruthy();
    expect(screen.getByTestId("metadata-generation-instructions-section")).toBeTruthy();
    expect(screen.getByTestId("metadata-generation-prompt-title")).toBeTruthy();
    expect(screen.getByTestId("metadata-generation-prompt-branchName")).toBeTruthy();
    expect(screen.getByTestId("metadata-generation-prompt-commitMessage")).toBeTruthy();
    expect(screen.getByTestId("metadata-generation-prompt-pullRequest")).toBeTruthy();

    const defaultElements = screen.getAllByText("Default");
    expect(defaultElements.length).toBeGreaterThanOrEqual(4);
  });

  it("displays configured prompt instructions", () => {
    configState.config = {
      ...configState.config!,
      metadataGeneration: {
        providers: [],
        title: { instructions: "Use Chinese task titles" },
        branchName: { instructions: "feat/<name>" },
      },
    } as unknown as MutableDaemonConfig;

    renderPage(<MetadataGenerationPage serverId="local" />);

    expect(screen.getByText("Use Chinese task titles")).toBeTruthy();
    expect(screen.getByText("feat/<name>")).toBeTruthy();
  });

  it("opens modal sheet and saves edited title prompt instructions", async () => {
    renderPage(<MetadataGenerationPage serverId="local" />);

    const titleRow = screen.getByTestId("metadata-generation-prompt-title");
    fireEvent.click(titleRow);

    await waitFor(() => {
      expect(screen.getByTestId("metadata-prompt-sheet-title")).toBeTruthy();
    });

    const input = screen.getByTestId("metadata-prompt-input-title");
    fireEvent.change(input, { target: { value: "Custom title prompt" } });

    const saveButton = screen.getByTestId("metadata-prompt-save");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(patchConfigMock).toHaveBeenCalledWith({
        metadataGeneration: {
          title: { instructions: "Custom title prompt" },
        },
      });
    });
  });

  it("resets prompt instructions to default", async () => {
    configState.config = {
      ...configState.config!,
      metadataGeneration: {
        providers: [],
        title: { instructions: "Custom prompt to reset" },
      },
    } as unknown as MutableDaemonConfig;

    renderPage(<MetadataGenerationPage serverId="local" />);

    const titleRow = screen.getByTestId("metadata-generation-prompt-title");
    fireEvent.click(titleRow);

    await waitFor(() => {
      expect(screen.getByTestId("metadata-prompt-sheet-title")).toBeTruthy();
    });

    const resetButton = screen.getByTestId("metadata-prompt-reset");
    fireEvent.click(resetButton);

    const saveButton = screen.getByTestId("metadata-prompt-save");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(patchConfigMock).toHaveBeenCalledWith({
        metadataGeneration: {
          title: null,
        },
      });
    });
  });
});
