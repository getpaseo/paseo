import { describe, expect, it } from "vitest";
import type { HostConfigDocument, MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { applyImport, type ImportPorts } from "./import.js";

const emptyDocument: HostConfigDocument = {
  format: "paseo-host-config",
  version: 1,
  config: {},
  plugins: [],
  manualPlugins: [],
  pluginSettings: [],
  redacted: [],
};

function ports(overrides: Partial<ImportPorts>): ImportPorts {
  const live = { pluginsEnabled: true, plugins: {} } as unknown as MutableDaemonConfig;
  return {
    readTarget: async () => ({ persisted: {}, live }),
    patch: async () => undefined,
    saveSkillSelection: async () => ({ confirmationRequired: null }),
    installPlugin: async () => {
      throw new Error("installPlugin not expected");
    },
    disablePlugin: async () => undefined,
    invokePluginRpc: async () => {
      throw new Error("invokePluginRpc not expected");
    },
    ...overrides,
  };
}

describe("applyImport", () => {
  it("reports a skills selection that would delete installed skills instead of deleting them", async () => {
    const outcome = await applyImport(
      {
        document: {
          ...emptyDocument,
          config: { skills: { mode: "custom", skills: ["paseo"] } },
        },
        sections: ["skills"],
        plugins: [],
        enablePlugins: false,
      },
      ports({ saveSkillSelection: async () => ({ confirmationRequired: { removals: ["loop"] } }) }),
    );

    expect(outcome.results).toEqual([
      {
        item: "section:skills",
        outcome: "failed",
        reason: "would remove skills loop; change the selection in Agents settings",
      },
    ]);
  });

  it("reports settings the plugin rejects with the plugin's own error", async () => {
    const outcome = await applyImport(
      {
        document: {
          ...emptyDocument,
          plugins: [
            {
              id: "review",
              enabled: true,
              installation: {
                identity: { kind: "npm", packageName: "review", pluginPath: "." },
                currentRevision: "1.0.0",
              },
            },
          ],
          pluginSettings: [
            { pluginId: "review", settingsId: "main", version: 1, values: { level: "max" } },
          ],
        },
        sections: [],
        plugins: ["review"],
        enablePlugins: false,
      },
      ports({
        installPlugin: async (input) => {
          expect(input).toEqual({ source: "npm:review@1.0.0", id: "review" });
          return { id: "review", path: "/x", enabled: true, status: "running" };
        },
        invokePluginRpc: async (_pluginId, method) =>
          method === "settings.main.read"
            ? { status: "ready", revision: "missing", values: {} }
            : { status: "invalid", error: "level: Invalid option" },
      }),
    );

    expect(outcome.results).toEqual([
      { item: "plugin:review", outcome: "applied" },
      { item: "settings:review/main", outcome: "failed", reason: "level: Invalid option" },
    ]);
  });
});
