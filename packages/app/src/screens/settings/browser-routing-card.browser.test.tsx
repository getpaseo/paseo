import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import type { RoutingDesktop } from "@/desktop/browser/network-routing/contract";
import { useNetworkRoutingStatus } from "@/desktop/browser/network-routing/status";
import { BrowserRoutingSetting } from "./browser-routing-card";
import { DesktopEventUnavailableError } from "@/desktop/electron/events";

/**
 * In-memory adapter for the desktop port: it keeps the choice the desktop main process would
 * persist and delivers `browser_routing_changed` like another app window toggling the host.
 */
class FakeRoutingDesktop implements RoutingDesktop {
  enabled = false;
  failNextLoad = false;
  failNextSave = false;
  saveReplyGate: Promise<void> | undefined;
  readReplyGate: Promise<void> | undefined;
  listenReplyGate: Promise<void> | undefined;
  listenFailure: { error: unknown } | undefined;
  listenCalls = 0;
  readonly reads: boolean[] = [];
  readonly saved: boolean[] = [];
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  async invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    if (command === "browser_routing_get_state") {
      if (this.failNextLoad) {
        this.failNextLoad = false;
        throw new Error("desktop bridge unavailable");
      }
      const enabled = this.enabled;
      this.reads.push(enabled);
      await this.readReplyGate;
      return { ok: true, enabled };
    }
    if (command === "browser_routing_set_enabled") {
      if (this.failNextSave) {
        this.failNextSave = false;
        return { ok: false, error: { code: "not_ready", message: "not ready" } };
      }
      this.enabled = args.enabled === true;
      this.saved.push(this.enabled);
      await this.saveReplyGate;
      return { ok: true };
    }
    throw new Error(`Unexpected desktop command: ${command}`);
  }

  async listen(event: string, handler: (payload: unknown) => void): Promise<() => void> {
    this.listenCalls += 1;
    await this.listenReplyGate;
    if (this.listenFailure) throw this.listenFailure.error;
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return () => handlers.delete(handler);
  }

  get listenerCount(): number {
    return this.listeners.get("browser_routing_changed")?.size ?? 0;
  }

  changeFromAnotherWindow(serverId: string, enabled: boolean): void {
    this.enabled = enabled;
    for (const handler of this.listeners.get("browser_routing_changed") ?? []) {
      handler({ serverId, enabled });
    }
  }
}

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}
const mounted: Mounted[] = [];

class SettingErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <div>Unexpected listener error</div> : this.props.children;
  }
}

interface MountOptions {
  available?: boolean;
  queryClient?: QueryClient;
  onCaughtError?: (error: unknown) => void;
}

function mountSetting(
  desktop: RoutingDesktop,
  {
    available = true,
    onCaughtError,
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    }),
  }: MountOptions = {},
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onCaughtError: (error) => onCaughtError?.(error) });
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <SettingErrorBoundary>
            <BrowserRoutingSetting serverId="remote" available={available} desktop={desktop} />
          </SettingErrorBoundary>
        </QueryClientProvider>
      </I18nextProvider>,
    ),
  );
  mounted.push({ root, container });
  return container;
}

function switchOf(container: HTMLElement): HTMLElement {
  const control = container.querySelector<HTMLElement>(
    '[data-testid="host-page-browser-routing-switch"]',
  );
  if (!control) throw new Error("Expected the routing switch");
  return control;
}
const isChecked = (container: HTMLElement) => switchOf(container).getAttribute("aria-checked");
const isDisabled = (container: HTMLElement) =>
  switchOf(container).getAttribute("aria-disabled") === "true";
const press = (element: HTMLElement) => act(() => element.click());

async function expectSwitchShows(container: HTMLElement, state: "on" | "off"): Promise<void> {
  await vi.waitFor(() => expect(isChecked(container)).toBe(state === "on" ? "true" : "false"));
}

beforeEach(async () => {
  // App sources compile against the classic JSX runtime, which expects React on the global.
  vi.stubGlobal("React", React);
  useNetworkRoutingStatus.setState({ hosts: {} });
  await i18n.changeLanguage("en");
});
afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  useNetworkRoutingStatus.setState({ hosts: {} });
});

describe("host browser routing setting", () => {
  it("keeps a failed subscription visible and retries it before allowing changes", async () => {
    const desktop = new FakeRoutingDesktop();
    desktop.listenFailure = { error: new DesktopEventUnavailableError() };
    const container = mountSetting(desktop);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Could not save or load this setting"),
    );
    expect(desktop.reads).toEqual([false]);
    expect(isDisabled(container)).toBe(true);
    expect(desktop.listenerCount).toBe(0);

    desktop.listenFailure = undefined;
    const retry = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (button) => button.textContent === "Retry",
    );
    if (!retry) throw new Error("Expected subscription retry action");
    press(retry);
    await vi.waitFor(() => expect(isDisabled(container)).toBe(false));
    expect(desktop.listenCalls).toBe(2);
    expect(desktop.listenerCount).toBe(1);
    expect(container.querySelector('[data-testid="host-page-browser-routing-error"]')).toBeNull();
    act(() => desktop.changeFromAnotherWindow("remote", true));
    await expectSwitchShows(container, "on");
  });

  it.each([
    new Error("unexpected listener failure"),
    new TypeError("bad listener"),
    "rejected",
    null,
  ])("propagates an unexpected listener failure unchanged: %s", async (error) => {
    const desktop = new FakeRoutingDesktop();
    desktop.listenFailure = { error };
    const onCaughtError = vi.fn();
    const container = mountSetting(desktop, { onCaughtError });
    await vi.waitFor(() => expect(onCaughtError).toHaveBeenCalledWith(error));
    expect(container.textContent).toBe("Unexpected listener error");
  });

  it("waits for subscription readiness and disposes a late listener after unmount", async () => {
    const desktop = new FakeRoutingDesktop();
    let finishListen: () => void = () => {
      throw new Error("Listener gate not initialized");
    };
    desktop.listenReplyGate = new Promise<void>((resolve) => {
      finishListen = resolve;
    });
    const container = mountSetting(desktop);
    await vi.waitFor(() => expect(desktop.reads).toEqual([false]));
    expect(isDisabled(container)).toBe(true);
    const entry = mounted.pop();
    if (!entry) throw new Error("Expected mounted setting");
    act(() => entry.root.unmount());
    entry.container.remove();
    await act(async () => finishListen());
    expect(desktop.listenerCount).toBe(0);
  });

  it("explains that an unsupported host must be updated", async () => {
    const container = mountSetting(new FakeRoutingDesktop(), { available: false });
    await vi.waitFor(() => expect(container.textContent).toContain("Update this host"));
    expect(isDisabled(container)).toBe(true);
  });

  it("persists the choice and reflects changes made by another window", async () => {
    const desktop = new FakeRoutingDesktop();
    const container = mountSetting(desktop);
    await vi.waitFor(() => expect(isDisabled(container)).toBe(false));
    expect(isChecked(container)).toBe("false");

    press(switchOf(container));
    await expectSwitchShows(container, "on");
    expect(desktop.saved).toEqual([true]);

    act(() => desktop.changeFromAnotherWindow("remote", false));
    await expectSwitchShows(container, "off");
  });

  it.each([false, true])(
    "keeps a newer window choice when an older save reply arrives (initially enabled: %s)",
    async (initiallyEnabled) => {
      const desktop = new FakeRoutingDesktop();
      desktop.enabled = initiallyEnabled;
      let finishSave: () => void = () => {
        throw new Error("Save reply gate not initialized");
      };
      desktop.saveReplyGate = new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      const container = mountSetting(desktop);
      await vi.waitFor(() => expect(isDisabled(container)).toBe(false));

      press(switchOf(container));
      await vi.waitFor(() => expect(desktop.saved).toEqual([!initiallyEnabled]));
      expect(isDisabled(container)).toBe(true);

      act(() => desktop.changeFromAnotherWindow("remote", initiallyEnabled));
      await act(async () => finishSave());
      await vi.waitFor(() => expect(isDisabled(container)).toBe(false));
      expect(isChecked(container)).toBe(String(desktop.enabled));
      expect(desktop.enabled).toBe(initiallyEnabled);
    },
  );

  it.each([
    { initiallyEnabled: false, initialLoad: true },
    { initiallyEnabled: true, initialLoad: true },
    { initiallyEnabled: false, initialLoad: false },
    { initiallyEnabled: true, initialLoad: false },
  ])(
    "keeps a newer window choice after an older read (enabled: $initiallyEnabled, initial load: $initialLoad)",
    async ({ initiallyEnabled, initialLoad }) => {
      const desktop = new FakeRoutingDesktop();
      desktop.enabled = initiallyEnabled;
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      let finishRead: () => void = () => {
        throw new Error("Read reply gate not initialized");
      };
      const gate = new Promise<void>((resolve) => {
        finishRead = resolve;
      });
      if (initialLoad) desktop.readReplyGate = gate;
      const container = mountSetting(desktop, { queryClient });
      if (!initialLoad) {
        await vi.waitFor(() => expect(isDisabled(container)).toBe(false));
        desktop.readReplyGate = gate;
      }
      let read: Promise<void> = Promise.resolve();
      act(() => {
        read = queryClient.refetchQueries(
          { queryKey: ["browser-routing", "remote"] },
          { cancelRefetch: false },
        );
      });
      await vi.waitFor(() =>
        expect(desktop.reads).toEqual(
          initialLoad ? [initiallyEnabled] : [initiallyEnabled, initiallyEnabled],
        ),
      );

      act(() => desktop.changeFromAnotherWindow("remote", !initiallyEnabled));
      await expectSwitchShows(container, initiallyEnabled ? "off" : "on");
      await act(async () => {
        finishRead();
        await read;
      });
      expect(queryClient.getQueryData(["browser-routing", "remote"])).toBe(!initiallyEnabled);
      await expectSwitchShows(container, initiallyEnabled ? "off" : "on");

      press(switchOf(container));
      await vi.waitFor(() => expect(desktop.saved).toEqual([initiallyEnabled]));
    },
  );

  it("shows a save failure and lets the user retry without changing the saved choice", async () => {
    const desktop = new FakeRoutingDesktop();
    const container = mountSetting(desktop);
    await vi.waitFor(() => expect(isDisabled(container)).toBe(false));

    desktop.failNextSave = true;
    press(switchOf(container));
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Could not save or load this setting. Try again."),
    );
    await expectSwitchShows(container, "off");
    expect(isDisabled(container)).toBe(false);
    expect(desktop.saved).toEqual([]);

    press(switchOf(container));
    await expectSwitchShows(container, "on");
    expect(container.querySelector('[data-testid="host-page-browser-routing-error"]')).toBeNull();
    expect(desktop.saved).toEqual([true]);
  });

  it("shows a load failure with a retry action instead of an editable false value", async () => {
    const desktop = new FakeRoutingDesktop();
    desktop.failNextLoad = true;
    const container = mountSetting(desktop);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Could not save or load this setting"),
    );
    expect(isDisabled(container)).toBe(true);

    const retry = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (button) => button.textContent === "Retry",
    );
    if (!retry) throw new Error("Expected the retry action");
    press(retry);
    await vi.waitFor(() => expect(isDisabled(container)).toBe(false));
  });

  it("allows turning routing off after the host loses the feature", async () => {
    const desktop = new FakeRoutingDesktop();
    desktop.enabled = true;
    const container = mountSetting(desktop, { available: false });
    await expectSwitchShows(container, "on");
    expect(isDisabled(container)).toBe(false);

    press(switchOf(container));
    await expectSwitchShows(container, "off");
    expect(desktop.saved).toEqual([false]);
    // Without the feature, the host can be turned off but not back on.
    expect(isDisabled(container)).toBe(true);
  });

  it("shows missing network permission and clears it once the host grants it", async () => {
    useNetworkRoutingStatus.getState().setStatus("remote", "permission_denied");
    const container = mountSetting(new FakeRoutingDesktop());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("does not have permission to use the host network"),
    );

    act(() => useNetworkRoutingStatus.getState().setStatus("remote", "ready"));
    expect(
      container.querySelector('[data-testid="host-page-browser-routing-permission-error"]'),
    ).toBeNull();
  });
});
