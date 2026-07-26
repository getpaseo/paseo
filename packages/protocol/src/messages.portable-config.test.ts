import { describe, expect, test } from "vitest";

import {
  DaemonConfigExportResponseSchema,
  DaemonConfigImportRequestSchema,
  ServerInfoStatusPayloadSchema,
} from "./messages.js";

const config = {
  version: 1 as const,
  exportedAt: "2026-07-26T10:00:00.000Z",
  projects: [
    {
      projectId: "project-1",
      rootPath: "/Users/old/code/client/repo",
      homeRelativePath: "code/client/repo",
      kind: "git" as const,
      displayName: "client/repo",
      customName: "Billing",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      customIcon: { kind: "emoji" as const, emoji: "\u{1F4B2}" },
    },
  ],
};

describe("portable configuration messages", () => {
  test("parses export responses and import requests", () => {
    expect(
      DaemonConfigExportResponseSchema.parse({
        type: "daemon.config.export.response",
        payload: { requestId: "export-1", config },
      }).payload.config,
    ).toEqual(config);
    expect(
      DaemonConfigImportRequestSchema.parse({
        type: "daemon.config.import.request",
        requestId: "import-1",
        config,
      }).config,
    ).toEqual(config);
  });

  test("keeps the feature flag optional for older daemons", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: {},
      }).features?.portableConfigBackup,
    ).toBeUndefined();
  });
});
