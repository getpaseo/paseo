/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { BrowserToolsOptInCard } from "./browser-tools-card";

const { isConnectedState, configState, patchConfigMock, theme } = vi.hoisted(() => ({
  isConnectedState: { value: true },
  configState: {
    config: {
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      appendSystemPrompt: "",
    } satisfies MutableDaemonConfig,
  },
  patchConfigMock: vi.fn(),
  theme: {
    spacing: { 1: 4, 3: 12, 4: 16, 6: 24 },
    fontSize: { xs: 11, base: 15 },
    fontWeight: { normal: "400" },
    borderRadius: { lg: 8 },
    colors: {
      surface1: "#111",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      statusDanger: "#ff0000",
    },
  },
}));

vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    onValueChange,
    disabled,
    testID,
  }: {
    value: boolean;
    onValueChange?: (next: boolean) => void;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement("button", {
      type: "button",
      role: "switch",
      "aria-checked": value ? "true" : "false",
      "aria-disabled": disabled ? "true" : undefined,
      "data-testid": testID,
      onClick: disabled ? undefined : () => onValueChange?.(!value),
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
  useHostRuntimeIsConnected: () => isConnectedState.value,
}));

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("BrowserToolsOptInCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    isConnectedState.value = true;
    configState.config = {
      ...configState.config,
      browserTools: { enabled: false },
    };
    patchConfigMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("disables the toggle and shows progress while saving", async () => {
    const deferred = createDeferred<MutableDaemonConfig>();
    patchConfigMock.mockReturnValue(deferred.promise);

    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <BrowserToolsOptInCard serverId="srv_test" />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-testid='host-page-browser-tools-switch']")
        ?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(patchConfigMock).toHaveBeenCalledWith({ browserTools: { enabled: true } });
    expect(
      container
        .querySelector("[data-testid='host-page-browser-tools-switch']")
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    expect(container.textContent).toContain("Updating browser tools…");

    await act(async () => {
      deferred.resolve(configState.config);
      await deferred.promise;
    });
  });

  it("shows a visible error when saving fails", async () => {
    patchConfigMock.mockRejectedValue(new Error("Disk is full"));

    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <BrowserToolsOptInCard serverId="srv_test" />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-testid='host-page-browser-tools-switch']")
        ?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      container.querySelector("[data-testid='host-page-browser-tools-error']")?.textContent,
    ).toBe("Disk is full");
  });
});
