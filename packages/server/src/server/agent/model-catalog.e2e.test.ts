import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";

import type { AgentModelDefinition } from "../agent-sdk-types.js";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

function isBinaryInstalled(binary: string): boolean {
  try {
    const out = execFileSync("which", [binary], { encoding: "utf8" }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

const hasCodex = isBinaryInstalled("codex");
const hasOpenCode = isBinaryInstalled("opencode");

function modelMatchesFamily(model: AgentModelDefinition, family: "sonnet" | "haiku"): boolean {
  const haystacks = [model.id, model.label, model.description ?? ""].map((value) =>
    value.toLowerCase(),
  );
  return haystacks.some((text) => text.includes(family));
}

describe("provider model catalogs (e2e)", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60_000);

  test("Claude catalog exposes Sonnet and Haiku variants", async () => {
    const result = await ctx.client.listProviderModels("claude");

    expect(result.error).toBeNull();
    expect(result.models.length).toBeGreaterThan(0);

    expect(result.models.some((model) => modelMatchesFamily(model, "sonnet"))).toBe(true);
    expect(result.models.some((model) => modelMatchesFamily(model, "haiku"))).toBe(true);
  }, 180_000);

  test.runIf(hasCodex)(
    "Codex catalog exposes gpt-5.1-codex",
    async () => {
      const result = await ctx.client.listProviderModels("codex");

      expect(result.error).toBeNull();
      const ids = result.models.map((model) => model.id);
      expect(ids.some((id) => id.startsWith("gpt-5.1-codex"))).toBe(true);
    },
    180_000,
  );

  test.runIf(hasOpenCode)(
    "OpenCode catalog returns models from multiple providers",
    async () => {
      const result = await ctx.client.listProviderModels("opencode");

      expect(result.error).toBeNull();
      expect(result.models.length).toBeGreaterThan(0);

      for (const model of result.models) {
        expect(model.provider).toBe("opencode");
        expect(model.id).toContain("/");
        expect(model.label).toBeTruthy();
        expect(model.metadata).toBeDefined();
        expect(model.metadata?.providerId).toBeTruthy();
        expect(model.metadata?.modelId).toBeTruthy();
      }

      const providerIds = new Set(result.models.map((m) => m.metadata?.providerId));
      expect(providerIds.size).toBeGreaterThan(0);
    },
    180_000,
  );
});
