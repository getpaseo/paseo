/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

// The page mounts with its real config hook, visibility hook, replica query and
// React Query. Only the RPC transport, the session store and platform widgets
// are controlled, so the test exercises the same fetch/retry path as the app.
const getDaemonConfig = vi.fn();
const patchDaemonConfig = vi.fn();

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ getDaemonConfig, patchDaemonConfig }),
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        host: {
          serverInfo: { features: { modelVisibility: true }, permissions: ["daemon.read"] },
        },
      },
    }),
}));

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityRole,
    accessibilityLabel,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    React.createElement(
      "div",
      {
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "data-testid": testID,
        onClick: onPress,
      },
      children,
    ),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? (factory as (theme: unknown) => unknown)({ colors: { foregroundMuted: "#aaa" } })
        : factory,
  },
}));

vi.mock("@/styles/settings", () => ({ settingsStyles: {} }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("span", { role: "progressbar" }),
}));

vi.mock("@/components/ui/external-link", () => ({
  ExternalLink: () => null,
}));

vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: ({ value, testID }: { value: string; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, value),
}));

vi.mock("@/components/settings/headings/settings-section", () => ({
  SettingsSection: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("section", { "data-testid": testID }, children),
}));

vi.mock("@/components/combined-model-selector", () => ({
  CombinedModelSelector: () => null,
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: [],
    isLoading: false,
    isFetching: false,
    isRefreshing: false,
    refetchIfStale: vi.fn(),
    refresh: vi.fn(async () => {}),
  }),
}));

import { MetadataGenerationPage } from "./metadata-generation-page";

const CONFIG: MutableDaemonConfig = {
  relay: { enabled: false },
  mcp: { injectIntoAgents: false },
  browserTools: { enabled: false },
  providers: {},
  metadataGeneration: { providers: [] },
  autoArchiveAfterMerge: false,
  enableTerminalAgentHooks: false,
  appendSystemPrompt: "",
};

const CONFIG_QUERY_KEY = ["daemon-config", "host"];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MetadataGenerationPage serverId="host" />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  // The unit project compiles JSX to React.createElement, so components without
  // a React import need it as a global, same as providers-section.test.tsx.
  vi.stubGlobal("React", React);
  getDaemonConfig.mockReset();
  patchDaemonConfig.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MetadataGenerationPage config loading", () => {
  it("renders Retry when the cold config fetch fails and recovers on click", async () => {
    getDaemonConfig.mockRejectedValueOnce(new Error("controlled initial RPC failure"));
    const client = mount();

    await waitFor(() => expect(client.getQueryState(CONFIG_QUERY_KEY)?.status).toBe("error"));
    expect(getDaemonConfig).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByTestId("metadata-generation-settings")).toBeNull();

    getDaemonConfig.mockResolvedValueOnce({ config: CONFIG });
    fireEvent.click(screen.getByRole("button", { name: "common.actions.retry" }));

    await waitFor(() =>
      expect(screen.queryByTestId("metadata-generation-settings")).not.toBeNull(),
    );
    expect(getDaemonConfig).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("metadata-generation-load-error")).toBeNull();
    expect(screen.getByTestId("metadata-generation-mode").textContent).toBe("automatic");
  });

  it("keeps cached settings usable when a later refresh fails", async () => {
    getDaemonConfig.mockResolvedValueOnce({ config: CONFIG });
    const client = mount();

    await waitFor(() =>
      expect(screen.queryByTestId("metadata-generation-settings")).not.toBeNull(),
    );

    getDaemonConfig.mockRejectedValueOnce(new Error("controlled refresh failure"));
    await client.refetchQueries({ queryKey: CONFIG_QUERY_KEY });

    await waitFor(() => expect(client.getQueryState(CONFIG_QUERY_KEY)?.status).toBe("error"));
    expect(screen.queryByTestId("metadata-generation-settings")).not.toBeNull();
    expect(screen.queryByTestId("metadata-generation-load-error")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
