import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import {
  ProviderInstallationSection,
  type ProviderInstallationState,
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
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ProviderInstallationSection state={state} updates={updates} />));
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
