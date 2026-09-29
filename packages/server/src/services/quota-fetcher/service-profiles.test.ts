import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { ProviderUsageFetcher } from "./provider.js";
import { ProviderUsageService } from "./service.js";
import { unavailableUsage } from "./usage.js";

function fakeFetcher(providerId: string): ProviderUsageFetcher {
  return {
    providerId,
    displayName: providerId,
    fetchUsage: async () => unavailableUsage({ providerId, displayName: providerId }),
  };
}

describe("ProviderUsageService with provider profiles", () => {
  it("drops disabled providers and adds one card per enabled Codex profile", async () => {
    const emptyHome = mkdtempSync(path.join(tmpdir(), "codex-home-"));
    const service = new ProviderUsageService({
      logger: createTestLogger(),
      fetchers: [fakeFetcher("claude"), fakeFetcher("codex"), fakeFetcher("copilot")],
      listProfiles: () => [
        { id: "codex", extends: null, label: null, enabled: false, env: {} },
        { id: "copilot", extends: null, label: null, enabled: false, env: {} },
        {
          id: "codex-plus",
          extends: "codex",
          label: "Codex Plus (privat)",
          enabled: true,
          env: { CODEX_HOME: emptyHome },
        },
        { id: "codex-off", extends: "codex", label: "Off", enabled: false, env: {} },
      ],
    });

    const result = await service.listUsage();

    expect(result.providers.map((usage) => [usage.providerId, usage.displayName])).toEqual([
      ["claude", "claude"],
      ["codex-plus", "Codex Plus (privat)"],
    ]);
    expect(result.providers.map((usage) => usage.baseProviderId)).toEqual([undefined, "codex"]);
  });

  it("refetches at once when an account is added, instead of waiting out the cache", async () => {
    const profiles = [{ id: "codex", extends: null, label: null, enabled: false, env: {} }];
    const service = new ProviderUsageService({
      logger: createTestLogger(),
      fetchers: [fakeFetcher("claude"), fakeFetcher("codex")],
      listProfiles: () => profiles,
    });
    expect((await service.listUsage()).providers.map((usage) => usage.providerId)).toEqual([
      "claude",
    ]);
    profiles.push({
      id: "codex-new",
      extends: "codex",
      label: "New",
      enabled: true,
      env: { CODEX_HOME: mkdtempSync(path.join(tmpdir(), "codex-home-")) },
    });
    expect((await service.listUsage()).providers.map((usage) => usage.providerId)).toEqual([
      "claude",
      "codex-new",
    ]);
  });
});
