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
    rerender: (nextUpdates: ProviderUpdatesState, nextAction?: ProviderUpdateAction) =>
      act(() =>
        root.render(
          <ProviderInstallationSection state={state} updates={nextUpdates} action={nextAction} />,
        ),
      ),
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

  it("offers a quiet install link when the installation check failed", async () => {
    const section = mount(
      ready({
        status: "ready",
        installation: {
          installUrl: INSTALL_URL,
          inspection: { status: "error", message: "version probe exploded" },
        },
      }),
    );
    await expect.element(section.view.getByText("version probe exploded")).toBeVisible();
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

  it("shows the reported versions and message as written, with Update instructions", async () => {
    const section = mount(installed, {
      status: "ready",
      updateCheck: {
        status: "available",
        versions: ["0.168.0", "nightly (unstable)"],
        message: "Restart to finish",
      },
    });
    await expect.element(section.view.getByText("Update available")).toBeVisible();
    expect(
      section.view.getAllByTestId("provider-updates-version").map((node) => node.textContent),
    ).toEqual(["0.168.0", "nightly (unstable)"]);
    await expect.element(section.view.getByText("Restart to finish")).toBeVisible();
    await expect
      .element(section.view.getByRole("button", { name: "Update instructions" }))
      .toBeVisible();
  });

  const inconclusive = [
    {
      name: "unknown",
      updates: { status: "ready", updateCheck: { status: "unknown", message: "Offline" } },
    },
    {
      name: "a thrown or timed-out check",
      updates: { status: "ready", updateCheck: { status: "error", message: "Offline" } },
    },
    { name: "a failed request", updates: { status: "error", message: "Offline" } },
  ] as const;

  it.each(inconclusive)("shows $name as inconclusive, never up to date", async ({ updates }) => {
    const section = mount(installed, updates);
    await expect.element(section.view.getByText("Couldn't check for updates")).toBeVisible();
    await expect.element(section.view.getByText("Offline")).toBeVisible();
    expect(section.view.queryByText("Up to date")).toBeNull();
    await expect
      .element(section.view.getByRole("button", { name: "Update instructions" }))
      .toBeVisible();
  });

  it.each(inconclusive)(
    "still says $name when the provider offers no update",
    async ({ updates }) => {
      const section = mount(
        ready({
          status: "ready",
          installation: { inspection: { status: "installed", version: "0.165.0" } },
        }),
        updates,
      );
      await expect.element(section.view.getByText("Couldn't check for updates")).toBeVisible();
      expect(section.view.queryByRole("button")).toBeNull();
    },
  );

  it("shows up to date only when the provider says so", async () => {
    const section = mount(installed, { status: "ready", updateCheck: { status: "current" } });
    await expect.element(section.view.getByText("Up to date")).toBeVisible();
  });

  it("shows the check's answer for a provider that offers no update", async () => {
    const section = mount(
      ready({
        status: "ready",
        installation: { inspection: { status: "installed", version: "1.4.18" } },
      }),
      { status: "ready", updateCheck: { status: "current" } },
    );
    await expect.element(section.view.getByText("Up to date")).toBeVisible();
    expect(section.view.queryByRole("button")).toBeNull();
  });

  it.each([
    { name: "cannot check", updates: { status: "ready", updateCheck: null } },
    { name: "is still checking", updates: { status: "loading" } },
  ] as const)(
    "shows no Updates row while a provider that offers no update $name",
    ({ updates }) => {
      const section = mount(
        ready({
          status: "ready",
          installation: {
            installUrl: INSTALL_URL,
            inspection: { status: "installed", version: "1.0.0" },
          },
        }),
        updates,
      );
      expect(section.view.queryByTestId("provider-updates")).toBeNull();
      expect(section.view.getByTestId("provider-installation-version").textContent).toBe("1.0.0");
    },
  );
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

  // The check only informs: Update and the update instructions never wait on it.
  const checkStates = [
    { name: "an update is available", updates: available, says: "Update available" },
    { name: "the provider cannot check", updates: { status: "ready", updateCheck: null } },
    { name: "the check is running", updates: { status: "loading" }, says: "Checking…" },
    {
      name: "the check could not tell",
      updates: { status: "ready", updateCheck: { status: "unknown" } },
      says: "Couldn't check for updates",
    },
    {
      name: "the check failed",
      updates: { status: "error", message: "Offline" },
      says: "Couldn't check for updates",
    },
    {
      name: "the provider is up to date",
      updates: { status: "ready", updateCheck: { status: "current" } },
      says: "Up to date",
    },
  ] satisfies { name: string; updates: ProviderUpdatesState; says?: string }[];

  it.each(checkStates)(
    "offers Update when $name and the provider runs its own",
    async ({ updates, says }) => {
      const control = action();
      const section = mount(installed(true), updates, control.value);
      const button = section.view.getByRole("button", { name: "Update" });
      act(() => button.click());
      expect(control.starts()).toBe(1);
      expect(section.view.queryByRole("button", { name: "Update instructions" })).toBeNull();
      if (says) await expect.element(section.view.getByText(says)).toBeVisible();
    },
  );

  it.each(checkStates)(
    "offers Update instructions when $name and the provider only links its guide",
    async ({ updates }) => {
      const section = mount(installed(false), updates, action().value);
      expect(section.view.queryByRole("button", { name: "Update" })).toBeNull();
      await expect
        .element(section.view.getByRole("button", { name: "Update instructions" }))
        .toBeVisible();
    },
  );

  it("shows no update status beside Update when the provider cannot check", () => {
    const section = mount(installed(true), { status: "ready", updateCheck: null }, action().value);
    expect(section.view.getByTestId("provider-updates").textContent).toBe("UpdatesUpdate");
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

  it("shows a failure with its message, its output and the update instructions", async () => {
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
    await expect.element(section.view.getByText("exited with code 1")).toBeVisible();
    expect(section.view.getByTestId("provider-update-output").textContent).toBe(
      "npm error EACCES\n",
    );
    await expect.element(section.view.getByText("Earlier output was dropped.")).toBeVisible();
    await expect
      .element(section.view.getByRole("link", { name: "Update instructions" }))
      .toBeVisible();
    await expect.element(section.view.getByRole("button", { name: "Update" })).toBeVisible();
  });

  // One update shows one progress indicator, in its own row, from the tap until it settles.
  describe("progress", () => {
    const runningUpdate = {
      operation: { ...operation, status: "running" as const },
      output: [{ type: "stdout" as const, text: "downloading\n" }],
    };
    function progress(section: ReturnType<typeof mount>) {
      const indicators = section.view.queryAllByRole("progressbar");
      const run = section.view.queryByTestId("provider-update-run");
      return {
        count: indicators.length,
        inRunRow: indicators.every((indicator) => run?.contains(indicator) ?? false),
      };
    }
    function geometry(section: ReturnType<typeof mount>) {
      const button = section.view.getByRole("button", { name: "Update" }).getBoundingClientRect();
      const status = section.view.queryByTestId("provider-update-status")?.parentElement;
      return {
        button: { x: button.x, y: button.y, width: button.width, height: button.height },
        statusLine: status
          ? { x: status.getBoundingClientRect().x, height: status.getBoundingClientRect().height }
          : null,
      };
    }
    const isDisabled = (section: ReturnType<typeof mount>) =>
      section.view.getByRole("button", { name: "Update" }).getAttribute("aria-disabled") === "true";

    it("keeps one indicator in the update's row from tap to settle, and moves nothing", () => {
      const previous = {
        operation: { ...operation, status: "failed" as const, finishedAt, message: "exit 1" },
        output: [{ type: "stderr" as const, text: "old failure\n" }],
      };
      const section = mount(installed(true), available, action({ current: previous }).value);
      const idle = geometry(section);
      expect(progress(section).count).toBe(0);
      expect(isDisabled(section)).toBe(false);

      // Tapped, the host has not answered yet: the previous result gives way to the start.
      section.rerender(available, action({ current: previous, starting: true }).value);
      expect(progress(section)).toEqual({ count: 1, inRunRow: true });
      expect(section.view.getByTestId("provider-update-status").textContent).toBe("Updating…");
      expect(section.view.queryByText("old failure")).toBeNull();
      expect(isDisabled(section)).toBe(true);
      expect(geometry(section).button).toEqual(idle.button);
      const startingLine = geometry(section).statusLine;

      // Progress can arrive before the host's answer to the start request.
      section.rerender(available, action({ current: runningUpdate, starting: true }).value);
      expect(progress(section)).toEqual({ count: 1, inRunRow: true });
      expect(section.view.getByTestId("provider-update-output").textContent).toBe("downloading\n");

      section.rerender(available, action({ current: runningUpdate }).value);
      expect(progress(section)).toEqual({ count: 1, inRunRow: true });
      expect(isDisabled(section)).toBe(true);
      expect(geometry(section).button).toEqual(idle.button);
      expect(geometry(section).statusLine).toEqual(startingLine);

      section.rerender(
        { status: "ready", updateCheck: { status: "current" } },
        action({
          current: {
            ...runningUpdate,
            operation: { ...operation, status: "succeeded", finishedAt },
          },
        }).value,
      );
      expect(progress(section).count).toBe(0);
      expect(section.view.getByTestId("provider-update-status").textContent).toBe("Updated");
      expect(isDisabled(section)).toBe(false);
      expect(geometry(section).button).toEqual(idle.button);
      expect(geometry(section).statusLine).toEqual(startingLine);
    });

    it("shows a running update in its row alone when the sheet reopens mid-update", () => {
      const section = mount(installed(true), available, action({ current: runningUpdate }).value);
      expect(progress(section)).toEqual({ count: 1, inRunRow: true });
      expect(isDisabled(section)).toBe(true);
    });

    it("drops the indicator when the host refuses the start", () => {
      const section = mount(installed(true), available, action({ starting: true }).value);
      expect(progress(section)).toEqual({ count: 1, inRunRow: true });
      const startingLine = geometry(section).statusLine;
      section.rerender(available, action({ startError: "Busy" }).value);
      expect(progress(section).count).toBe(0);
      expect(section.view.getByTestId("provider-update-status").textContent).toBe("Update failed");
      expect(geometry(section).statusLine).toEqual(startingLine);
    });
  });

  it("shows why the host refused to start the update", async () => {
    const section = mount(
      installed(true),
      available,
      action({ startError: "Provider codex cannot update itself" }).value,
    );
    expect(section.view.getByTestId("provider-update-status").textContent).toBe("Update failed");
    await expect
      .element(section.view.getByText("Provider codex cannot update itself"))
      .toBeVisible();
  });
});
