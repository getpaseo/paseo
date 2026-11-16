import { describe, expect, test } from "vitest";
import type { HostConfigDocument } from "@getpaseo/protocol/messages";
import {
  formatImportPreview,
  importHostConfig,
  parseHostConfigFile,
  type ImportInteraction,
} from "./config-transfer.js";

const document: HostConfigDocument = {
  format: "paseo-host-config",
  version: 1,
  config: { profiles: {}, speech: {} },
  plugins: [],
  manualPlugins: [],
  pluginSettings: [],
  redacted: [],
};

const preview = {
  requestId: "r",
  sections: [
    { id: "profiles", status: "ready" as const, changes: ["agentProfiles"], issues: [] },
    { id: "speech", status: "invalid" as const, changes: [], issues: ["speech.x: Unrecognized"] },
  ],
  plugins: [
    { id: "review", status: "install" as const, source: "npm:review@1.0.0" },
    { id: "local", status: "manual" as const, reason: "directory-source" },
  ],
  requiresPluginsEnabled: true,
  pluginsStartedByEnabling: ["already-there"],
};

function fakeClient(features: Record<string, boolean>) {
  const applied: unknown[] = [];
  return {
    applied,
    getLastServerInfoMessage: () => ({ features }) as never,
    exportConfig: async () => ({ requestId: "r", document }),
    previewConfigImport: async () => preview,
    applyConfigImport: async (input: unknown) => {
      applied.push(input);
      return { requestId: "r", results: [], reenter: [] };
    },
  };
}

const nonInteractive: ImportInteraction = {
  interactive: false,
  structured: false,
  write: () => undefined,
  confirm: async () => true,
};

describe("daemon config import", () => {
  test("refuses to apply without --yes when it cannot ask, and applies nothing", async () => {
    const client = fakeClient({ configTransfer: true });
    await expect(
      importHostConfig(client, document, { yes: false, enablePlugins: false }, nonInteractive),
    ).rejects.toThrow("Confirmation required; rerun with --yes.");
    expect(client.applied).toEqual([]);
  });

  test("applies only ready sections and installable plugins", async () => {
    const client = fakeClient({ configTransfer: true });
    await importHostConfig(client, document, { yes: true, enablePlugins: true }, nonInteractive);
    expect(client.applied).toEqual([
      { document, sections: ["profiles"], plugins: ["review"], enablePlugins: true },
    ]);
  });

  test("asks the host to update when it cannot transfer configuration", async () => {
    await expect(
      importHostConfig(
        fakeClient({}),
        document,
        { yes: true, enablePlugins: false },
        nonInteractive,
      ),
    ).rejects.toEqual({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to export or import its configuration.",
    });
  });

  test("the preview names what turning plugins on would also start", () => {
    expect(formatImportPreview(preview, true)).toBe(
      [
        "Sections:",
        "  profiles: replaces agentProfiles",
        "  speech: invalid, not applied: speech.x: Unrecognized",
        "Plugins:",
        "  review: install from npm:review@1.0.0",
        "  local: manual (directory-source)",
        "Plugins will be turned on for this host, which also starts: already-there.",
        "",
      ].join("\n"),
    );
  });

  test("rejects a file that is not a host config export", () => {
    expect(() =>
      parseHostConfigFile("backup.json", JSON.stringify({ format: "paseo-backup", version: 1 })),
    ).toThrow('backup.json is not a Paseo host config export (format "paseo-host-config")');
  });
});
