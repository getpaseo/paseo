import { useNetworkRoutingStatus } from "@/desktop/browser/network-routing/status";
/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";

const state = vi.hoisted(() => ({
  electron: true,
  local: false,
  supported: true,
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listener: null as ((raw: unknown) => void) | null,
}));
vi.mock("@/constants/platform", () => ({ getIsElectron: () => state.electron }));
vi.mock("@/hooks/use-is-local-daemon", () => ({
  useIsLocalDaemon: () => state.local,
  useLocalDaemonServerIdState: () => ({ status: "resolved", serverId: "local" }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (value: unknown) => unknown) =>
    select({
      sessions: { remote: { serverInfo: { features: { networkTunnel: state.supported } } } },
    }),
}));
vi.mock("@/desktop/electron/invoke", () => ({ invokeDesktopCommand: state.invoke }));
vi.mock("@/desktop/electron/events", () => ({
  listenToDesktopEvent: async (_event: string, callback: (raw: unknown) => void) => {
    state.listener = callback;
    return () => {
      state.listener = null;
    };
  },
}));
vi.mock("@/components/settings/headings/settings-section", () => ({
  SettingsSection: ({ title, children }: { title: string; children: React.ReactNode }) =>
    React.createElement("section", { "aria-label": title }, children),
}));
vi.mock("@/styles/settings", () => ({ settingsStyles: {} }));
vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
}));
vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    disabled,
    onValueChange,
  }: {
    value: boolean;
    disabled: boolean;
    onValueChange: (value: boolean) => void;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        role: "switch",
        "aria-checked": value,
        disabled,
        onClick: () => onValueChange(!value),
      },
      "Switch",
    ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress }: { children: React.ReactNode; onPress: () => void }) =>
    React.createElement("button", { type: "button", onClick: onPress }, children),
}));
import { BrowserRoutingCard } from "./browser-routing-card";

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}
async function renderCard() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <BrowserRoutingCard serverId="remote" />
      </QueryClientProvider>,
    );
  });
  await flush();
}
function toggle() {
  return container.querySelector<HTMLButtonElement>('[role="switch"]')!;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  useNetworkRoutingStatus.setState({ hosts: {} });
  state.electron = true;
  state.local = false;
  state.supported = true;
  state.invoke.mockReset();
  state.invoke.mockImplementation(async (command) =>
    command === "browser_routing_get_state" ? { ok: true, enabled: false } : { ok: true },
  );
  await i18n.changeLanguage("en");
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.useRealTimers();
});

describe("host browser routing setting", () => {
  it.each(["browser", "local"])("hides the option for %s", async (kind) => {
    state.electron = kind !== "browser";
    state.local = kind === "local";
    await renderCard();
    expect(container.textContent).toBe("");
    expect(state.invoke).not.toHaveBeenCalled();
  });
  it("explains that an unsupported host must be updated", async () => {
    state.supported = false;
    await renderCard();
    expect(toggle().disabled).toBe(true);
    expect(container.textContent).toContain("Update this host");
  });
  it("persists the choice and reflects changes made by another window", async () => {
    await renderCard();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle().click());
    await flush();
    expect(state.invoke).toHaveBeenCalledWith("browser_routing_set_enabled", {
      serverId: "remote",
      enabled: true,
    });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await act(async () => state.listener?.({ serverId: "remote", enabled: false }));
    await flush();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });
  it("shows a save failure and lets the user retry without changing the saved choice", async () => {
    await renderCard();
    state.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: "not_ready", message: "not ready" },
    });
    await act(async () => toggle().click());
    await flush();
    expect(container.textContent).toContain("Could not save or load this setting. Try again.");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().disabled).toBe(false);
    await act(async () => toggle().click());
    await flush();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('[data-testid="host-page-browser-routing-error"]')).toBeNull();
  });
  it("shows a load failure with a retry action instead of an editable false value", async () => {
    state.invoke.mockRejectedValueOnce(new Error("IPC unavailable"));
    await renderCard();
    expect(toggle().disabled).toBe(true);
    expect(container.textContent).toContain("Could not save or load this setting");
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    )!;
    await act(async () => retry.click());
    await flush();
    expect(toggle().disabled).toBe(false);
  });
});

it("allows turning routing off after the host loses the feature", async () => {
  state.supported = false;
  state.invoke.mockResolvedValueOnce({ ok: true, enabled: true });
  await renderCard();
  expect(toggle().disabled).toBe(false);
  await act(async () => toggle().click());
  await flush();
  expect(state.invoke).toHaveBeenCalledWith("browser_routing_set_enabled", {
    serverId: "remote",
    enabled: false,
  });
  expect(toggle().disabled).toBe(true);
});
it("shows missing network permission in the host's Browser section", async () => {
  useNetworkRoutingStatus.getState().setStatus("remote", "permission_denied");
  await renderCard();
  expect(container.querySelector('section[aria-label="Browser"]')).not.toBeNull();
  expect(container.textContent).toContain("does not have permission to use the host network");
  await act(async () => {
    useNetworkRoutingStatus.getState().setStatus("remote", "ready");
  });
  expect(
    container.querySelector('[data-testid="host-page-browser-routing-permission-error"]'),
  ).toBeNull();
});
