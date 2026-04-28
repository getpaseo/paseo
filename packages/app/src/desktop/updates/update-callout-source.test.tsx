/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarCalloutSlot } from "@/components/sidebar-callout-slot";
import { SidebarCalloutProvider } from "@/contexts/sidebar-callout-context";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16 },
    iconSize: { sm: 14, md: 18 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6 },
    fontSize: { xs: 11, sm: 13 },
    fontWeight: { medium: "500", semibold: "600" },
    shadow: { md: {} },
    colors: {
      surface0: "#000",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      destructive: "#ff4444",
    },
  },
}));

const asyncStorage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItem: vi.fn(async (key: string) => asyncStorage.values.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => {
    asyncStorage.values.set(key, value);
  }),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorage,
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("lucide-react-native", () => {
  const X = (props: Record<string, unknown>) => React.createElement("span", props);
  const Gift = (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": "Gift" });
  return { Gift, X };
});

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: vi.fn(async () => {}),
}));

const updaterState = vi.hoisted(() => ({
  value: {
    isDesktopApp: true,
    status: "available" as
      | "idle"
      | "checking"
      | "pending"
      | "up-to-date"
      | "available"
      | "installing"
      | "installed"
      | "error",
    availableUpdate: {
      hasUpdate: true,
      readyToInstall: true,
      currentVersion: "1.2.2",
      latestVersion: "1.2.3",
      body: null,
      date: null,
    } as unknown,
    errorMessage: null as string | null,
    lastCheckedAt: null as number | null,
    isChecking: false,
    isInstalling: false,
    statusText: "",
    checkForUpdates: vi.fn(async () => null),
    installUpdate: vi.fn(async () => null),
  },
}));

vi.mock("@/desktop/updates/use-desktop-app-updater", () => ({
  useDesktopAppUpdater: () => updaterState.value,
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { UpdateCalloutSource } from "./update-callout-source";

function resetUpdaterState(): void {
  updaterState.value = {
    isDesktopApp: true,
    status: "available",
    availableUpdate: {
      hasUpdate: true,
      readyToInstall: true,
      currentVersion: "1.2.2",
      latestVersion: "1.2.3",
      body: null,
      date: null,
    },
    errorMessage: null,
    lastCheckedAt: null,
    isChecking: false,
    isInstalling: false,
    statusText: "",
    checkForUpdates: vi.fn(async () => null),
    installUpdate: vi.fn(async () => null),
  };
}

function UpdateCalloutHarness({ withSlot = true }: { withSlot?: boolean }) {
  return (
    <SidebarCalloutProvider>
      <UpdateCalloutSource />
      {withSlot ? <SidebarCalloutSlot /> : null}
    </SidebarCalloutProvider>
  );
}

async function renderHarness(root: Root, withSlot = true): Promise<void> {
  await act(async () => {
    root.render(<UpdateCalloutHarness withSlot={withSlot} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("UpdateCalloutSource", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    resetUpdaterState();
    asyncStorage.values.clear();
    asyncStorage.getItem.mockClear();
    asyncStorage.setItem.mockClear();
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
    root = null;
    container?.remove();
    container = null;
  });

  it("registers an update-available sidebar callout with changelog + install actions", async () => {
    await renderHarness(root!);

    expect(container?.querySelector('[data-testid="update-callout"]')).not.toBeNull();
    expect(container?.textContent).toContain("Update available");
    expect(container?.textContent).toContain("1.2.3");
    expect(container?.textContent).toContain(
      "Upgrading the app will stop running agents and close terminal sessions.",
    );
    expect(container?.querySelector('[data-icon="Gift"]')).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="update-callout-action-0"]')?.textContent,
    ).toContain("What's new");
    expect(
      container?.querySelector('[data-testid="update-callout-action-1"]')?.textContent,
    ).toContain("Install & restart");
  });

  it("renders only through the sidebar slot", async () => {
    await renderHarness(root!, false);

    expect(container?.querySelector('[data-testid="update-callout"]')).toBeNull();
  });

  it("shows only the changelog action once the update is installed", async () => {
    updaterState.value = {
      ...updaterState.value,
      status: "installed",
      availableUpdate: null,
    };
    await renderHarness(root!);

    expect(container?.textContent).toContain("Update installed");
    expect(
      container?.querySelector('[data-testid="update-callout-action-0"]')?.textContent,
    ).toContain("What's new");
    expect(container?.querySelector('[data-testid="update-callout-action-1"]')).toBeNull();
  });

  it("disables the install action and shows Installing... while installing", async () => {
    updaterState.value = {
      ...updaterState.value,
      status: "installing",
      isInstalling: true,
    };
    await renderHarness(root!);

    expect(
      container?.querySelector('[data-testid="update-callout-action-1"]')?.textContent,
    ).toContain("Installing");
  });

  it("shows a retry action on error and surfaces the error message", async () => {
    updaterState.value = {
      ...updaterState.value,
      status: "error",
      errorMessage: "Download failed",
      availableUpdate: null,
    };
    await renderHarness(root!);

    expect(container?.textContent).toContain("Update failed");
    expect(container?.textContent).toContain("Download failed");
    expect(
      container?.querySelector('[data-testid="update-callout-action-1"]')?.textContent,
    ).toContain("Retry");
  });

  it("renders nothing when not running as a desktop app", async () => {
    updaterState.value = { ...updaterState.value, isDesktopApp: false };
    await renderHarness(root!);

    expect(container?.querySelector('[data-testid="update-callout"]')).toBeNull();
  });

  it("renders nothing when status is idle / checking / up-to-date / pending", async () => {
    for (const status of ["idle", "checking", "up-to-date", "pending"] as const) {
      resetUpdaterState();
      updaterState.value = { ...updaterState.value, status };
      const innerContainer = document.createElement("div");
      document.body.appendChild(innerContainer);
      const innerRoot = createRoot(innerContainer);
      await act(async () => {
        innerRoot.render(<UpdateCalloutHarness />);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(innerContainer.querySelector('[data-testid="update-callout"]')).toBeNull();
      act(() => {
        innerRoot.unmount();
      });
      innerContainer.remove();
    }
  });

  it("dismisses the registered update callout", async () => {
    await renderHarness(root!);

    const dismiss = container?.querySelector(
      '[data-testid="update-callout-dismiss"]',
    ) as HTMLElement | null;
    expect(dismiss).not.toBeNull();
    act(() => {
      dismiss?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container?.querySelector('[data-testid="update-callout"]')).toBeNull();
    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      "@paseo:sidebar-callout-dismissals",
      JSON.stringify(["desktop-update:available:1.2.3"]),
    );
  });
});
