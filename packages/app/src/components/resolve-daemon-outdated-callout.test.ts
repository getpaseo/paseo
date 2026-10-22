import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  resolveDaemonOutdatedCallout,
  type ResolveDaemonOutdatedCalloutInput,
} from "./resolve-daemon-outdated-callout";

function input(
  overrides: Partial<ResolveDaemonOutdatedCalloutInput> = {},
): ResolveDaemonOutdatedCalloutInput {
  return {
    serverId: "srv_alpha",
    hostLabel: "Workstation",
    appVersion: "0.12.0",
    daemonVersion: "0.11.4",
    supportsSelfUpdate: true,
    desktopManaged: false,
    terminalsSurviveRestart: true,
    isConnected: true,
    update: { status: "idle" },
    ...overrides,
  };
}

describe("resolveDaemonOutdatedCallout", () => {
  it("shows an update notice when the daemon is older than the app", () => {
    expect(resolveDaemonOutdatedCallout(input())).toEqual({
      id: "daemon-outdated",
      dismissalKey: "daemon-outdated:srv_alpha:0.11.4",
      priority: 250,
      title: "Daemon out of date",
      description: [
        "Workstation runs daemon v0.11.4. This app is v0.12.0.",
        "Updating restarts the daemon. Terminals stay open.",
      ],
      variant: "default",
      updateAction: { label: "Update", disabled: false },
      testID: "daemon-outdated-callout",
    });
  });

  it("hides when the daemon matches or is newer than the app", () => {
    expect(resolveDaemonOutdatedCallout(input({ daemonVersion: "0.12.0" }))).toBeNull();
    expect(resolveDaemonOutdatedCallout(input({ daemonVersion: "v0.12.0" }))).toBeNull();
    expect(resolveDaemonOutdatedCallout(input({ daemonVersion: "0.12.1" }))).toBeNull();
    expect(resolveDaemonOutdatedCallout(input({ daemonVersion: "1.0.0" }))).toBeNull();
  });

  it("compares numeric components numerically, not as strings", () => {
    expect(
      resolveDaemonOutdatedCallout(input({ appVersion: "0.10.0", daemonVersion: "0.9.9" })),
    ).not.toBeNull();
    expect(
      resolveDaemonOutdatedCallout(input({ appVersion: "0.9.9", daemonVersion: "0.10.0" })),
    ).toBeNull();
  });

  it("orders prereleases before their release", () => {
    expect(
      resolveDaemonOutdatedCallout(input({ appVersion: "0.12.0", daemonVersion: "0.12.0-beta.1" })),
    ).not.toBeNull();
    expect(
      resolveDaemonOutdatedCallout(input({ appVersion: "0.12.0-beta.1", daemonVersion: "0.12.0" })),
    ).toBeNull();
    expect(
      resolveDaemonOutdatedCallout(
        input({ appVersion: "0.12.0-beta.10", daemonVersion: "0.12.0-beta.2" }),
      ),
    ).not.toBeNull();
    expect(
      resolveDaemonOutdatedCallout(
        input({ appVersion: "0.12.0-beta.2", daemonVersion: "0.12.0-beta.2" }),
      ),
    ).toBeNull();
    expect(
      resolveDaemonOutdatedCallout(input({ appVersion: "0.12.0-rc.1", daemonVersion: "0.11.9" })),
    ).not.toBeNull();
  });

  it("hides when either version is missing or unparseable", () => {
    expect(resolveDaemonOutdatedCallout(input({ daemonVersion: null }))).toBeNull();
    expect(resolveDaemonOutdatedCallout(input({ appVersion: null }))).toBeNull();
    expect(resolveDaemonOutdatedCallout(input({ daemonVersion: "dev" }))).toBeNull();
    expect(resolveDaemonOutdatedCallout(input({ daemonVersion: "0.11" }))).toBeNull();
    expect(resolveDaemonOutdatedCallout(input({ appVersion: "unknown" }))).toBeNull();
  });

  it("offers no button for a desktop-managed daemon and points to Paseo on that computer", () => {
    const descriptor = resolveDaemonOutdatedCallout(input({ desktopManaged: true }));

    expect(descriptor?.updateAction).toBeNull();
    expect(descriptor?.description).toEqual([
      "Workstation runs daemon v0.11.4. This app is v0.12.0.",
      "Paseo Desktop manages this daemon. Update Paseo on that computer.",
      "Updating Paseo Desktop keeps terminals open on macOS and Linux, and closes them on Windows.",
    ]);
  });

  it("never promises terminals survive a desktop update, which closes them on Windows", () => {
    const descriptor = resolveDaemonOutdatedCallout(
      input({ desktopManaged: true, terminalsSurviveRestart: true }),
    );

    expect(descriptor?.description).not.toContain(
      "Updating restarts the daemon. Terminals stay open.",
    );
    expect(descriptor?.description.at(-1)).toContain("closes them on Windows");
  });

  it("says a desktop update closes terminals when the daemon does not keep them", () => {
    const descriptor = resolveDaemonOutdatedCallout(
      input({ desktopManaged: true, terminalsSurviveRestart: false }),
    );

    expect(descriptor?.description.at(-1)).toBe(
      "Updating restarts the daemon and closes open terminals.",
    );
  });

  it("offers no button when the daemon does not support self-update", () => {
    const descriptor = resolveDaemonOutdatedCallout(input({ supportsSelfUpdate: false }));

    expect(descriptor?.updateAction).toBeNull();
    expect(descriptor?.description).toContain(
      "This daemon can't update itself. Update Paseo on that computer.",
    );
  });

  it("says the update closes terminals when the daemon does not keep them", () => {
    const descriptor = resolveDaemonOutdatedCallout(input({ terminalsSurviveRestart: false }));

    expect(descriptor?.description).toEqual([
      "Workstation runs daemon v0.11.4. This app is v0.12.0.",
      "Updating restarts the daemon and closes open terminals.",
    ]);
  });

  it("disables the button while the host is disconnected", () => {
    expect(resolveDaemonOutdatedCallout(input({ isConnected: false }))?.updateAction).toEqual({
      label: "Update",
      disabled: true,
    });
  });

  it("shows the update phase on a disabled button while updating", () => {
    const descriptor = resolveDaemonOutdatedCallout(
      input({ update: { status: "updating", phase: "Downloading packages..." } }),
    );

    expect(descriptor?.variant).toBe("default");
    expect(descriptor?.updateAction).toEqual({ label: "Downloading packages...", disabled: true });
  });

  it("surfaces a failed update as an error with the button available again", () => {
    const descriptor = resolveDaemonOutdatedCallout(
      input({ update: { status: "failed", message: "Failed to update the daemon: boom" } }),
    );

    expect(descriptor?.title).toBe("Daemon update failed");
    expect(descriptor?.variant).toBe("error");
    expect(descriptor?.description).toEqual(["Failed to update the daemon: boom"]);
    expect(descriptor?.updateAction).toEqual({ label: "Update", disabled: false });
  });

  it("keys dismissal by host and daemon version", () => {
    const key = resolveDaemonOutdatedCallout(input())?.dismissalKey;

    expect(resolveDaemonOutdatedCallout(input({ daemonVersion: "v0.11.4" }))?.dismissalKey).toBe(
      key,
    );
    expect(resolveDaemonOutdatedCallout(input({ appVersion: "0.13.0" }))?.dismissalKey).toBe(key);
    expect(resolveDaemonOutdatedCallout(input({ daemonVersion: "0.11.5" }))?.dismissalKey).toBe(
      "daemon-outdated:srv_alpha:0.11.5",
    );
    expect(resolveDaemonOutdatedCallout(input({ serverId: "srv_beta" }))?.dismissalKey).toBe(
      "daemon-outdated:srv_beta:0.11.4",
    );
  });

  it("uses the active app language", async () => {
    await i18n.changeLanguage("es");
    try {
      const descriptor = resolveDaemonOutdatedCallout(input({ terminalsSurviveRestart: false }));

      expect(descriptor?.title).toBe("Daemon desactualizado");
      expect(descriptor?.description).toEqual([
        "Workstation ejecuta el daemon v0.11.4. Esta app es v0.12.0.",
        "Actualizar reinicia el daemon y cierra las terminales abiertas.",
      ]);
      expect(descriptor?.updateAction?.label).toBe("Actualizar");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
