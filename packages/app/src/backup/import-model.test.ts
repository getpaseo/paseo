import { describe, expect, it } from "vitest";
import type { HostConfigDocument } from "@getpaseo/protocol/messages";
import { defaultHostAppearance } from "@/hosts/appearance";
import type { ParsedBackup } from "./bundle";
import {
  applyBackup,
  availableDeviceItems,
  defaultDeviceSelection,
  defaultHostChoice,
  hostPartState,
  hostSelection,
  planPreviewRequests,
  type BackupImportPorts,
  type HostImportPreview,
  type HostPreviewState,
} from "./import-model";

const document: HostConfigDocument = {
  format: "paseo-host-config",
  version: 1,
  config: {},
  plugins: [],
  manualPlugins: [],
  pluginSettings: [],
  redacted: [],
};

const backup: ParsedBackup = {
  createdAt: "2026-10-28T00:00:00.000Z",
  device: {
    shortcutOverrides: { "new-workspace": "Mod+2" },
    desktopSettings: {
      releaseChannel: "beta",
      notifications: { playSound: false },
      daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
    },
    hosts: [
      {
        profile: {
          serverId: "srv_work",
          label: "Work",
          appearance: defaultHostAppearance(),
          lifecycle: {},
          connections: [],
          preferredConnectionId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        passwordRequired: true,
      },
    ],
  },
  hosts: [{ serverId: "srv_source", label: "Old laptop", document }],
  unreadable: [],
};

const preview = {
  sections: [{ id: "profiles", status: "ready", changes: ["agentProfiles"], issues: [] }],
  plugins: [],
  requiresPluginsEnabled: false,
  pluginsStartedByEnabling: [],
} satisfies HostImportPreview;

function recordingPorts(overrides: Partial<BackupImportPorts> = {}) {
  const calls: string[] = [];
  const ports: BackupImportPorts = {
    saveAppSettings: async () => void calls.push("appSettings"),
    replaceShortcutOverrides: async (value) =>
      void calls.push(`shortcuts ${JSON.stringify(value)}`),
    saveChangesPreferences: async () => void calls.push("changes"),
    patchDesktopSettings: async (patch) => void calls.push(`desktop ${JSON.stringify(patch)}`),
    importHosts: async (profiles) => void calls.push(`hosts ${profiles.length}`),
    applyHostImport: async (serverId, request) => {
      calls.push(`host ${serverId} ${request.sections.join(",")}`);
      return {
        results: [{ item: "section:profiles", outcome: "applied" }],
        reenter: [{ path: "agents.providers.claude.env", kind: "secret" }],
      };
    },
    ...overrides,
  };
  return { calls, ports };
}

describe("backup import model", () => {
  it("offers this machine's built-in daemon toggles unticked", () => {
    const items = availableDeviceItems(backup, true);
    expect(items).toEqual(["shortcutOverrides", "desktopSettings", "desktopDaemon", "hosts"]);
    expect(defaultDeviceSelection(items)).toEqual([
      "shortcutOverrides",
      "desktopSettings",
      "hosts",
    ]);
    expect(availableDeviceItems(backup, false)).toEqual(["shortcutOverrides", "hosts"]);
  });

  it("ticks every section and plugin the target can apply, but not turning plugins on", () => {
    expect(
      defaultHostChoice("srv_source", "srv_target", {
        sections: [
          { id: "profiles", status: "ready", changes: ["agentProfiles"], issues: [] },
          { id: "speech", status: "unchanged", changes: [], issues: [] },
          { id: "providers", status: "invalid", changes: [], issues: ["x"] },
        ],
        plugins: [
          { id: "review", status: "install", source: "npm:review@1.0.0" },
          { id: "local", status: "manual", reason: "directory-source" },
        ],
        requiresPluginsEnabled: true,
        pluginsStartedByEnabling: [],
      }),
    ).toEqual({
      sourceServerId: "srv_source",
      targetServerId: "srv_target",
      sections: ["profiles"],
      plugins: ["review"],
      enablePlugins: false,
    });
  });

  it("applies only what is ticked and lists what to re-enter", async () => {
    const { calls, ports } = recordingPorts();

    const outcome = await applyBackup(
      backup,
      {
        device: ["desktopSettings", "hosts"],
        hosts: [
          {
            sourceServerId: "srv_source",
            targetServerId: "srv_target",
            sections: ["profiles"],
            plugins: [],
            enablePlugins: false,
          },
        ],
      },
      ports,
    );

    expect(calls).toEqual([
      'desktop {"releaseChannel":"beta","notifications":{"playSound":false}}',
      "hosts 1",
      "host srv_target profiles",
    ]);
    expect(outcome).toEqual({
      results: [
        { scope: "device", item: "desktopSettings", outcome: "applied" },
        { scope: "device", item: "hosts", outcome: "applied" },
        { scope: "srv_target", item: "section:profiles", outcome: "applied" },
      ],
      reenter: [
        { scope: "srv_work", path: "Work", kind: "password" },
        { scope: "srv_target", path: "agents.providers.claude.env", kind: "secret" },
      ],
    });
  });

  it("reports a failed section and still applies the rest", async () => {
    const { calls, ports } = recordingPorts({
      replaceShortcutOverrides: async () => {
        throw new Error("storage unavailable");
      },
      applyHostImport: async () => {
        throw new Error("Update the host to export or import its configuration.");
      },
    });

    const outcome = await applyBackup(
      backup,
      {
        device: ["shortcutOverrides", "desktopDaemon"],
        hosts: [
          {
            sourceServerId: "srv_source",
            targetServerId: "srv_target",
            sections: [],
            plugins: [],
            enablePlugins: false,
          },
        ],
      },
      ports,
    );

    expect(calls).toEqual([
      'desktop {"daemon":{"manageBuiltInDaemon":false,"keepRunningAfterQuit":true}}',
    ]);
    expect(outcome.results).toEqual([
      {
        scope: "device",
        item: "shortcutOverrides",
        outcome: "failed",
        reason: "storage unavailable",
      },
      { scope: "device", item: "desktopDaemon", outcome: "applied" },
      {
        scope: "srv_target",
        item: "host",
        outcome: "failed",
        reason: "Update the host to export or import its configuration.",
      },
    ]);
  });

  // On Android the file picker backgrounds the app, so the sheet opens while the host reconnects.
  it("waits for the target host to be connected before asking for a preview", () => {
    const targets = { srv_source: "srv_target" };

    expect(planPreviewRequests(backup.hosts, targets, () => false, {})).toEqual({
      ask: [],
      forget: [],
    });
    expect(planPreviewRequests(backup.hosts, targets, () => true, {})).toEqual({
      ask: [{ part: backup.hosts[0], target: "srv_target" }],
      forget: [],
    });
  });

  it("asks again after a reconnect when the host dropped before answering", () => {
    const targets = { srv_source: "srv_target" };
    const failed: Record<string, HostPreviewState> = {
      srv_source: { status: "error", target: "srv_target", message: "lost" },
    };

    expect(planPreviewRequests(backup.hosts, targets, () => false, failed)).toEqual({
      ask: [],
      forget: ["srv_source"],
    });
    expect(planPreviewRequests(backup.hosts, targets, () => true, failed).ask).toEqual([]);
  });

  it("keeps a finished preview through a reconnect and asks a newly chosen host", () => {
    const ready: Record<string, HostPreviewState> = {
      srv_source: {
        status: "ready",
        target: "srv_target",
        preview: {
          sections: [],
          plugins: [],
          requiresPluginsEnabled: false,
          pluginsStartedByEnabling: [],
        },
      },
    };

    expect(
      planPreviewRequests(backup.hosts, { srv_source: "srv_target" }, () => false, ready),
    ).toEqual({ ask: [], forget: [] });
    expect(
      planPreviewRequests(backup.hosts, { srv_source: "srv_target" }, () => true, ready).ask,
    ).toEqual([]);
    expect(
      planPreviewRequests(backup.hosts, { srv_source: "srv_other" }, () => true, ready).ask,
    ).toEqual([{ part: backup.hosts[0], target: "srv_other" }]);
  });

  it("holds Apply while a host part waits for its host", () => {
    const checking = hostPartState("srv_source", "srv_target", "connecting", undefined, undefined);
    const offline = hostPartState("srv_source", "srv_target", "offline", undefined, undefined);

    expect(checking).toEqual({ kind: "checking" });
    expect(offline).toEqual({ kind: "offline" });
    expect(hostSelection([checking])).toBeNull();
    expect(hostSelection([offline])).toBeNull();
  });

  it("applies a part only to the host that answered for it", () => {
    const answeredByOther: HostPreviewState = { status: "ready", target: "srv_old", preview };
    const answered: HostPreviewState = { status: "ready", target: "srv_target", preview };
    const editedForOther = { ...defaultHostChoice("srv_source", "srv_old", preview), sections: [] };

    expect(hostPartState("srv_source", "srv_target", "online", answeredByOther, undefined)).toEqual(
      { kind: "checking" },
    );
    expect(hostPartState("srv_source", "srv_target", "online", answered, editedForOther)).toEqual({
      kind: "ready",
      preview,
      choice: defaultHostChoice("srv_source", "srv_target", preview),
    });
  });

  it("sends the edited choice of each ready part and leaves out the rest", () => {
    const edited = { ...defaultHostChoice("srv_source", "srv_target", preview), sections: [] };
    const ready = hostPartState(
      "srv_source",
      "srv_target",
      "online",
      { status: "ready", target: "srv_target", preview },
      edited,
    );
    const failed = hostPartState(
      "srv_other",
      "srv_target",
      "online",
      { status: "error", target: "srv_target", message: "invalid" },
      undefined,
    );
    const unassigned = hostPartState("srv_third", null, "online", undefined, undefined);

    expect(failed).toEqual({ kind: "failed", message: "invalid" });
    expect(unassigned).toEqual({ kind: "unassigned" });
    expect(hostSelection([ready, failed, unassigned])).toEqual([edited]);
  });
});
