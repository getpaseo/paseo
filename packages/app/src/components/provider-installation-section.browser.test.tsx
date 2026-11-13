import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import {
  ProviderInstallationSection,
  type ProviderInstallationState,
  type ProviderUpdateAction,
  type ProviderUpdatesState,
} from "./provider-installation-section";

// Load translations so controls expose their real accessible names.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

const mounted: { root: Root; container: HTMLDivElement }[] = [];
afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

const INSTALL_URL = "https://example.com/install";
const UPDATE_URL = "https://example.com/update";

function mount(
  state: ProviderInstallationState,
  updates: ProviderUpdatesState = { status: "hidden" },
  action?: ProviderUpdateAction,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(<ProviderInstallationSection state={state} updates={updates} action={action} />),
  );
  mounted.push({ root, container });
  const view = within(container);
  return {
    view,
    installButton: () => view.queryByRole("button", { name: "Install" }),
    installLink: () => view.queryByRole("link", { name: "Install instructions" }),
  };
}

function ready(installation: ProviderInstallationState & { status: "ready" }) {
  return installation;
}

describe("install link visibility", () => {
  it("offers the Install button when the provider reports it is not installed", () => {
    const section = mount(
      ready({
        status: "ready",
        installation: { installUrl: INSTALL_URL, inspection: { status: "not_installed" } },
      }),
    );
    expect(section.installButton()).not.toBeNull();
    expect(section.installLink()).toBeNull();
  });

  it("offers a quiet install link when the installation check failed", () => {
    const section = mount(
      ready({
        status: "ready",
        installation: {
          installUrl: INSTALL_URL,
          inspection: { status: "error", message: "version probe exploded" },
        },
      }),
    );
    expect(section.view.getByText("version probe exploded")).toBeTruthy();
    expect(section.installLink()).not.toBeNull();
    expect(section.installButton()).toBeNull();
  });

  it("offers a quiet install link for a provider that only declares where to install it", () => {
    const section = mount(ready({ status: "ready", installation: { installUrl: INSTALL_URL } }));
    expect(section.installLink()).not.toBeNull();
    expect(section.installButton()).toBeNull();
  });

  it("offers no install link once the provider reports it is installed", () => {
    const section = mount(
      ready({
        status: "ready",
        installation: {
          installUrl: INSTALL_URL,
          inspection: { status: "installed", version: "1" },
        },
      }),
    );
    expect(section.installLink()).toBeNull();
    expect(section.installButton()).toBeNull();
  });
});

describe("update check", () => {
  const installed = ready({
    status: "ready",
    installation: {
      installUrl: INSTALL_URL,
      updateUrl: UPDATE_URL,
      inspection: { status: "installed", version: "0.165.0" },
    },
  });

  it("shows the reported versions and message as written, with Update instructions", () => {
    const section = mount(installed, {
      status: "ready",
      updateCheck: {
        status: "available",
        versions: ["0.168.0", "nightly (unstable)"],
        message: "Restart to finish",
      },
    });
    expect(section.view.getByText("Update available")).toBeTruthy();
    expect(
      section.view.getAllByTestId("provider-updates-version").map((node) => node.textContent),
    ).toEqual(["0.168.0", "nightly (unstable)"]);
    expect(section.view.getByText("Restart to finish")).toBeTruthy();
    expect(section.view.getByRole("button", { name: "Update instructions" })).toBeTruthy();
  });

  it.each([
    {
      name: "unknown",
      updates: { status: "ready", updateCheck: { status: "unknown", message: "Offline" } },
    },
    {
      name: "a thrown or timed-out check",
      updates: { status: "ready", updateCheck: { status: "error", message: "Offline" } },
    },
    { name: "a failed request", updates: { status: "error", message: "Offline" } },
  ] as const)("shows $name as inconclusive, never up to date", ({ updates }) => {
    const section = mount(installed, updates);
    expect(section.view.getByText("Couldn't check for updates")).toBeTruthy();
    expect(section.view.getByText("Offline")).toBeTruthy();
    expect(section.view.queryByText("Up to date")).toBeNull();
    expect(section.view.getByRole("link", { name: "Update instructions" })).toBeTruthy();
  });

  it("shows up to date only when the provider says so", () => {
    const section = mount(installed, { status: "ready", updateCheck: { status: "current" } });
    expect(section.view.getByText("Up to date")).toBeTruthy();
  });
});

describe("update action", () => {
  const installed = (canUpdate: boolean) =>
    ready({
      status: "ready",
      installation: {
        updateUrl: UPDATE_URL,
        inspection: { status: "installed", version: "1.0.0" },
        ...(canUpdate ? { canUpdate: true } : {}),
      },
    });
  const available: ProviderUpdatesState = {
    status: "ready",
    updateCheck: { status: "available", versions: ["2.0.0"] },
  };
  function action(overrides: Partial<ProviderUpdateAction> = {}) {
    let starts = 0;
    const value: ProviderUpdateAction = {
      current: null,
      starting: false,
      startError: null,
      start: () => {
        starts += 1;
      },
      ...overrides,
    };
    return { value, starts: () => starts };
  }
  const operation = { id: "op", startedAt: "2026-11-13T00:00:00.000Z" };
  const finishedAt = "2026-11-13T00:01:00.000Z";

  it("offers Update when an update is available and the provider runs its own", () => {
    const control = action();
    const section = mount(installed(true), available, control.value);
    const button = section.view.getByRole("button", { name: "Update" });
    act(() => button.click());
    expect(control.starts()).toBe(1);
    expect(section.view.queryByRole("button", { name: "Update instructions" })).toBeNull();
  });

  it("keeps Update instructions when the provider does not run its own update", () => {
    const section = mount(installed(false), available, action().value);
    expect(section.view.queryByRole("button", { name: "Update" })).toBeNull();
    expect(section.view.getByRole("button", { name: "Update instructions" })).toBeTruthy();
  });

  it("shows a running update with its output so far", () => {
    const section = mount(
      installed(true),
      available,
      action({
        current: {
          operation: { ...operation, status: "running" },
          output: [
            { type: "message", text: "Running codex update\n" },
            { type: "stdout", text: "added 1 package\n" },
          ],
        },
      }).value,
    );
    expect(section.view.getByTestId("provider-update-status").textContent).toBe("Updating…");
    expect(section.view.getByTestId("provider-update-output").textContent).toBe(
      "Running codex update\nadded 1 package\n",
    );
  });

  it("shows the provider's success message as written", () => {
    const section = mount(
      installed(true),
      { status: "ready", updateCheck: { status: "current" } },
      action({
        current: {
          operation: {
            ...operation,
            status: "succeeded",
            finishedAt,
            message: " Restart agents \n",
          },
          output: [],
        },
      }).value,
    );
    expect(section.view.getByTestId("provider-update-status").textContent).toBe("Updated");
    expect(section.view.getByTestId("provider-update-message").textContent).toBe(
      " Restart agents \n",
    );
    expect(section.view.queryByTestId("provider-update-output")).toBeNull();
  });

  it("shows a failure with its message, its output and the update instructions", () => {
    const section = mount(
      installed(true),
      available,
      action({
        current: {
          operation: { ...operation, status: "failed", finishedAt, message: "exited with code 1" },
          output: [{ type: "stderr", text: "npm error EACCES\n" }],
          truncated: true,
        },
      }).value,
    );
    expect(section.view.getByTestId("provider-update-status").textContent).toBe("Update failed");
    expect(section.view.getByText("exited with code 1")).toBeTruthy();
    expect(section.view.getByTestId("provider-update-output").textContent).toBe(
      "npm error EACCES\n",
    );
    expect(section.view.getByText("Earlier output was dropped.")).toBeTruthy();
    expect(section.view.getByRole("link", { name: "Update instructions" })).toBeTruthy();
    expect(section.view.getByRole("button", { name: "Update" })).toBeTruthy();
  });

  it("shows why the host refused to start the update", () => {
    const section = mount(
      installed(true),
      available,
      action({ startError: "Provider codex cannot update itself" }).value,
    );
    expect(section.view.getByTestId("provider-update-status").textContent).toBe("Update failed");
    expect(section.view.getByText("Provider codex cannot update itself")).toBeTruthy();
  });
});
