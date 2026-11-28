import { describe, expect, test } from "vitest";

import { buildProviderCommand } from "@/utils/provider-command-templates";

describe("buildProviderCommand", () => {
  test("builds Hermes resume commands from native session ids", () => {
    expect(
      buildProviderCommand({
        provider: "hermes",
        id: "resume",
        sessionId: "20260813_111500_abc123",
      }),
    ).toBe("hermes --resume 20260813_111500_abc123");
  });

  test("builds OpenCode resume commands from native session ids", () => {
    expect(
      buildProviderCommand({
        provider: "opencode",
        id: "resume",
        sessionId: "ses_abc123",
      }),
    ).toBe("opencode --session ses_abc123");
  });

  const nativeId = "119830f6-909e-46d1-b58b-13a1726080ae";

  test.each(["sessionId", "conversationId"])(
    "builds an Antigravity resume command from a persisted %s",
    (key) => {
      expect(
        buildProviderCommand({
          provider: "antigravity",
          id: "resume",
          sessionId: `plugin:${JSON.stringify({ version: 1, data: { [key]: nativeId } })}`,
        }),
      ).toBe(`agy --conversation ${nativeId}`);
    },
  );

  test("reads Antigravity's structured plugin persistence when available", () => {
    expect(
      buildProviderCommand({
        provider: "antigravity",
        id: "resume",
        sessionId: 'plugin:{"version":1,"data":{"sessionId":"older-id"}}',
        pluginPersistence: { version: 1, data: { sessionId: nativeId } },
      }),
    ).toBe(`agy --conversation ${nativeId}`);
  });

  test.each([
    nativeId,
    "plugin:malformed",
    'plugin:{"version":2,"data":{"sessionId":"other"}}',
    'plugin:{"version":1,"data":null}',
    'plugin:{"version":1,"data":{"sessionId":42}}',
    'plugin:{"version":1,"data":{"sessionId":""}}',
    'plugin:{"version":1,"data":{"sessionId":"id; printf unsafe"}}',
    'plugin:{"version":1,"data":{"sessionId":"--help"}}',
    `plugin:${JSON.stringify({ version: 1, data: { sessionId: "id\n" } })}`,
  ])("rejects an invalid Antigravity persistence handle: %s", (sessionId) => {
    expect(buildProviderCommand({ provider: "antigravity", id: "resume", sessionId })).toBeNull();
  });
});
