import { describe, expect, test } from "vitest";

import { buildProviderCommand } from "@/utils/provider-command-templates";

describe("buildProviderCommand", () => {
  test("builds OpenCode resume commands from native session ids", () => {
    expect(
      buildProviderCommand({
        provider: "opencode",
        id: "resume",
        sessionId: "ses_abc123",
      }),
    ).toBe("opencode --session ses_abc123");
  });
});
