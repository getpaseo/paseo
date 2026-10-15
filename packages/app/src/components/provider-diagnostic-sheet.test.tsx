/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse("2026-01-01T12:00:00.000Z");

const { theme, snapshotState, configState, hostState, patchConfigMock } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 8: 32 },
    iconSize: { sm: 14, md: 20 },
    fontSize: { base: 15, code: 12, sm: 13 },
    fontWeight: { normal: "400", medium: "500" },
    fontFamily: { mono: "mono" },
    borderRadius: { full: 999, lg: 8 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      destructive: "#ff0000",
      border: "#555",
      surface2: "#222",
    },
  },
  snapshotState: {
    entries: undefined as ProviderSnapshotEntry[] | undefined,
    isRefreshing: false,
    refresh: undefined as unknown as ReturnType<typeof vi.fn>,
  },
  configState: {
    config: null as MutableDaemonConfig | null,
  },
  hostState: {
    isConnected: true,
  },
  patchConfigMock: vi.fn(async () => undefined),
}));

snapshotState.refresh = vi.fn(async (_providers?: unknown) => {});

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
  Pressable: ({
    children,
    onPress,
    onHoverIn,
    onHoverOut,
    accessibilityRole,
    accessibilityLabel,
    disabled,
    testID,
  }: {
    children?:
      | React.ReactNode
      | ((state: { pressed: boolean; hovered: boolean }) => React.ReactNode);
    onPress?: (event: React.MouseEvent) => void;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "div",
      {
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "aria-disabled": disabled ? "true" : undefined,
        "data-testid": testID,
        onClick: disabled ? undefined : onPress,
        onMouseEnter: onHoverIn,
        onMouseLeave: onHoverOut,
      },
      typeof children === "function" ? children({ pressed: false, hovered: false }) : children,
    ),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme, rt: { breakpoint: "md" } }),
}));

const tFn = vi.hoisted(() =>
  vi.fn((key: string) => {
    const map: Record<string, string> = {
      "settings.providers.updateErrorTitle": "Unable to update provider",
      "settings.providers.diagnostic.refresh": "Refresh",
      "settings.providers.diagnostic.refreshing": "Refreshing...",
      "settings.providers.models.loading": "Loading models",
      "settings.providers.models.noneDetected": "No models detected",
      "settings.providers.models.retry": "Retry",
      "settings.providers.models.retrying": "Retrying...",
    };
    return map[key] ?? key;
  }),
);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tFn }),
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveTextInput: ({
    onChangeText,
  }: {
    onSubmitEditing?: () => void;
    onChangeText?: (value: string) => void;
  }) =>
    React.createElement("input", {
      onChange: (event: { target: HTMLInputElement }) => onChangeText?.(event.target.value),
    }),
  AdaptiveModalSheet: ({
    children,
    footer,
    visible,
    testID,
  }: {
    children?: React.ReactNode;
    footer?: React.ReactNode;
    visible: boolean;
    testID?: string;
  }) =>
    visible
      ? React.createElement(
          "div",
          { "data-testid": testID },
          children,
          React.createElement("div", { className: "sheet-footer" }, footer),
        )
      : null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) =>
    React.createElement(
      "button",
      { type: "button", disabled, onClick: () => onPress?.() },
      children,
    ),
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("span", { "data-testid": "loading-spinner" }),
}));

vi.mock("@/components/ui/scrollable-code-surface", () => ({
  SurfaceCard: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  ScrollableCodeSurface: ({ children }: { children?: React.ReactNode; maxHeight?: number }) =>
    React.createElement("div", null, children),
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(async () => undefined),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ copied: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
  getIsElectron: () => false,
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: snapshotState.entries,
    isLoading: false,
    isFetching: false,
    isRefreshing: snapshotState.isRefreshing,
    error: null,
    supportsSnapshot: true,
    refresh: snapshotState.refresh,
    refetchIfStale: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: configState.config,
    isLoading: false,
    patchConfig: patchConfigMock,
  }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => null,
  useHostRuntimeIsConnected: () => hostState.isConnected,
}));

import { ProviderDiagnosticSheet } from "./provider-diagnostic-sheet";

function codexEntry(overrides: Partial<ProviderSnapshotEntry> = {}): ProviderSnapshotEntry {
  return {
    provider: "codex",
    status: "ready",
    enabled: true,
    label: "Codex",
    description: "OpenAI Codex",
    defaultModeId: null,
    modes: [],
    models: [{ provider: "codex", id: "gpt-6-astra", label: "GPT-6 Astra" }],
    ...overrides,
  };
}

function fetchedAtString(ageMs: number | null): string | undefined {
  if (ageMs === null) return undefined;
  return new Date(NOW - ageMs).toISOString();
}

describe("ProviderDiagnosticSheet codex auto-refresh", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let onCloseMock: () => void;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onCloseMock = vi.fn(() => {}) as unknown as () => void;

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);

    snapshotState.entries = undefined;
    snapshotState.isRefreshing = false;
    snapshotState.refresh.mockReset();
    snapshotState.refresh.mockImplementation(async () => {});
    configState.config = null;
    hostState.isConnected = true;
    patchConfigMock.mockReset();
    patchConfigMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function renderSheet(props: {
    provider?: string;
    visible?: boolean;
    strictMode?: boolean;
  }): void {
    const { provider = "codex", visible = false, strictMode = false } = props;
    const sheet = React.createElement(ProviderDiagnosticSheet, {
      provider,
      serverId: "server-1",
      visible,
      onClose: onCloseMock,
    });
    const children = strictMode ? React.createElement(React.StrictMode, null, sheet) : sheet;
    act(() => {
      root?.render(React.createElement(React.Fragment, null, children));
    });
  }

  function setVisible(visible: boolean): void {
    renderSheet({ visible });
  }

  function flush(): Promise<void> {
    return act(async () => {});
  }

  function autoRefreshCallCount(): number {
    return snapshotState.refresh.mock.calls.filter(
      (call) => JSON.stringify(call[0]) === JSON.stringify(["codex"]),
    ).length;
  }

  function errorTarget(): HTMLElement | null {
    return (
      container?.querySelector<HTMLElement>('[data-testid="provider-settings-refresh-error"]') ??
      null
    );
  }

  function pressManualRefresh(): void {
    const button = Array.from(container?.querySelectorAll("button") ?? []).find(
      (node) => node.textContent === "Refresh",
    );
    if (!button) throw new Error("Manual refresh button not rendered");
    act(() => {
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
  }

  it("requests exactly one refresh when a codex sheet opens with a catalog older than one hour", async () => {
    snapshotState.entries = [codexEntry({ fetchedAt: fetchedAtString(2 * HOUR_MS) })];
    renderSheet({ visible: false });
    await flush();
    expect(autoRefreshCallCount()).toBe(0);

    setVisible(true);
    await flush();
    expect(autoRefreshCallCount()).toBe(1);

    // Rerenders, entry pushes, and clock ticks must not cause a second attempt.
    snapshotState.entries = [
      codexEntry({
        fetchedAt: fetchedAtString(2 * HOUR_MS),
        models: [],
      }),
    ];
    await flush();
    vi.setSystemTime(NOW + 10 * 60_000);
    await flush();
    expect(autoRefreshCallCount()).toBe(1);
  });

  it("does not request for a fresh catalog and the fresh close consumes the evaluation", async () => {
    snapshotState.entries = [codexEntry({ fetchedAt: fetchedAtString(5 * 60_000) })];
    renderSheet({ visible: false });
    await flush();
    setVisible(true);
    await flush();
    expect(autoRefreshCallCount()).toBe(0);

    // The catalog goes stale mid-open; the one-shot evaluation was already consumed.
    snapshotState.entries = [codexEntry({ fetchedAt: fetchedAtString(2 * HOUR_MS) })];
    await flush();
    vi.setSystemTime(NOW + HOUR_MS);
    await flush();
    expect(autoRefreshCallCount()).toBe(0);

    // A close and a fresh open are needed for a new evaluation.
    setVisible(false);
    await flush();
    setVisible(true);
    await flush();
    expect(autoRefreshCallCount()).toBe(1);
  });

  it("treats missing, invalid, future, and threshold-age fetchedAt as stale", async () => {
    renderSheet({ visible: false });
    await flush();

    let expectedTotal = 0;
    for (const scenario of [
      { name: "missing", fetchedAt: fetchedAtString(null) },
      { name: "invalid", fetchedAt: "not-a-date" },
      { name: "future", fetchedAt: new Date(NOW + HOUR_MS).toISOString() },
      { name: "threshold", fetchedAt: fetchedAtString(HOUR_MS) },
    ] as const) {
      expectedTotal += 1;
      snapshotState.entries = [codexEntry({ fetchedAt: scenario.fetchedAt })];
      setVisible(true);
      await flush();
      expect(autoRefreshCallCount(), scenario.name).toBe(expectedTotal);

      setVisible(false);
      await flush();
      expect(autoRefreshCallCount(), `after close (${scenario.name})`).toBe(expectedTotal);
    }
  });

  it("blocks until the host connects and refreshes once once connected", async () => {
    hostState.isConnected = false;
    snapshotState.entries = [codexEntry({ fetchedAt: fetchedAtString(2 * HOUR_MS) })];
    renderSheet({ visible: true });
    await flush();
    expect(autoRefreshCallCount()).toBe(0);

    hostState.isConnected = true;
    // The reconnection surfaces through a fresh render, the way a real push does.
    snapshotState.entries = [codexEntry({ fetchedAt: fetchedAtString(2 * HOUR_MS) })];
    setVisible(true);
    await flush();
    expect(autoRefreshCallCount()).toBe(1);
  });

  it("waits for an in-flight load, then refreshes the finished catalog", async () => {
    snapshotState.entries = [
      codexEntry({ status: "loading", fetchedAt: fetchedAtString(2 * HOUR_MS) }),
    ];
    renderSheet({ visible: true });
    await flush();
    expect(autoRefreshCallCount()).toBe(0);

    snapshotState.entries = [codexEntry({ fetchedAt: fetchedAtString(2 * HOUR_MS) })];
    setVisible(true);
    await flush();
    expect(autoRefreshCallCount()).toBe(1);
  });

  it("never auto-refreshes disabled, unavailable, or non-codex sheets", async () => {
    snapshotState.entries = [
      codexEntry({ enabled: false, fetchedAt: fetchedAtString(2 * HOUR_MS) }),
    ];
    renderSheet({ visible: true });
    await flush();
    expect(autoRefreshCallCount()).toBe(0);

    snapshotState.entries = [
      codexEntry({ status: "unavailable", fetchedAt: fetchedAtString(2 * HOUR_MS) }),
    ];
    setVisible(true);
    await flush();
    expect(autoRefreshCallCount()).toBe(0);

    renderSheet({ provider: "claude", visible: true });
    await flush();
    expect(autoRefreshCallCount()).toBe(0);

    // Switching back to a stale codex entry remounts the sheet (keyed by serverId:provider
    // in production) and must evaluate exactly once.
    snapshotState.entries = [codexEntry({ fetchedAt: fetchedAtString(2 * HOUR_MS) })];
    setVisible(true);
    await flush();
    expect(autoRefreshCallCount()).toBe(1);
  });

  it("renders one auto-refresh under Strict Mode double mounting", async () => {
    snapshotState.entries = [codexEntry({ fetchedAt: fetchedAtString(2 * HOUR_MS) })];
    renderSheet({ visible: true, strictMode: true });
    await flush();
    expect(autoRefreshCallCount()).toBe(1);
  });

  it("shows a persistent error on refresh rejection, loops never, and manual retry recovers", async () => {
    snapshotState.refresh.mockImplementation(async () => {
      throw new Error("sync failed");
    });
    snapshotState.entries = [
      codexEntry({
        fetchedAt: fetchedAtString(2 * HOUR_MS),
        models: [{ provider: "codex", id: "gpt-6-astra", label: "GPT-6 Astra" }],
      }),
    ];
    renderSheet({ visible: true });
    await flush();
    expect(snapshotState.refresh).toHaveBeenCalledTimes(1);

    expect(errorTarget()?.textContent).toBe("sync failed");

    // No auto retry loop.
    vi.setSystemTime(NOW + 5 * 60_000);
    await flush();
    expect(snapshotState.refresh).toHaveBeenCalledTimes(1);

    // Manual button still works and clears the error.
    snapshotState.refresh.mockImplementation(async () => {});
    pressManualRefresh();
    await flush();
    expect(snapshotState.refresh).toHaveBeenCalledTimes(2);
    expect(errorTarget()).toBeNull();

    // Rejection without a message falls back to the shared title.
    snapshotState.refresh.mockImplementation(async () => {
      throw new TypeError();
    });
    setVisible(false);
    await flush();
    snapshotState.entries = [codexEntry({ fetchedAt: fetchedAtString(2 * HOUR_MS) })];
    setVisible(true);
    await flush();
    expect(errorTarget()?.textContent).toBe("Unable to update provider");
    expect(snapshotState.refresh).toHaveBeenCalledTimes(3);

    // The error clears on close.
    setVisible(false);
    await flush();
    expect(errorTarget()).toBeNull();
  });

  it("manual refresh forces a request even when the codex catalog is fresh", async () => {
    snapshotState.entries = [codexEntry({ fetchedAt: fetchedAtString(60_000) })];
    renderSheet({ visible: true });
    await flush();
    expect(autoRefreshCallCount()).toBe(0);

    pressManualRefresh();
    await flush();
    expect(autoRefreshCallCount()).toBe(1);
  });
});
