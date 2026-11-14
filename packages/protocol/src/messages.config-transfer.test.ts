import { describe, expect, it } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages";

const document = {
  format: "paseo-host-config",
  version: 1,
  daemonVersion: "0.14.0",
  config: { profiles: { agentProfiles: [], terminalProfiles: [] }, newerSection: { x: 1 } },
  plugins: [
    {
      id: "review",
      enabled: true,
      installation: { identity: { kind: "future-kind", url: "x" } },
    },
  ],
  manualPlugins: [{ id: "local-tools", reason: "directory-source" }],
  pluginSettings: [{ pluginId: "review", settingsId: "main", version: 2, values: { a: 1 } }],
  redacted: [{ path: "agents.providers.claude.env", kind: "secret" }],
};

describe("config transfer protocol", () => {
  it("carries a host document whose sections and plugin installations it does not interpret", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "daemon.config.import.apply.request",
      requestId: "request-1",
      document,
      sections: ["profiles"],
      plugins: ["review"],
      enablePlugins: false,
    });
    expect(parsed).toEqual({
      type: "daemon.config.import.apply.request",
      requestId: "request-1",
      document,
      sections: ["profiles"],
      plugins: ["review"],
      enablePlugins: false,
    });
  });

  it("rejects a document of another format", () => {
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "daemon.config.import.preview.request",
        requestId: "request-2",
        document: { ...document, format: "paseo-backup" },
      }).success,
    ).toBe(false);
  });

  it("parses export, preview and apply responses", () => {
    for (const message of [
      { type: "daemon.config.export.response", payload: { requestId: "r", document } },
      {
        type: "daemon.config.import.preview.response",
        payload: {
          requestId: "r",
          sections: [{ id: "profiles", status: "ready", changes: ["agentProfiles"], issues: [] }],
          plugins: [{ id: "review", status: "install", source: "npm:review@1.0.0" }],
          requiresPluginsEnabled: true,
          pluginsStartedByEnabling: ["already-there"],
        },
      },
      {
        type: "daemon.config.import.apply.response",
        payload: {
          requestId: "r",
          results: [{ item: "plugin:review", outcome: "failed", reason: "network" }],
          reenter: [{ path: "agents.providers.claude.env", kind: "secret" }],
        },
      },
    ]) {
      expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(true);
    }
  });
});
