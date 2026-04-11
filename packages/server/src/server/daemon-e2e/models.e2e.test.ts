import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createDaemonTestContext } from "../test-utils/index.js";

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

describe("daemon E2E", () => {
  describe("listProviderModels", () => {
    test.runIf(hasCodex)(
      "returns model list for Codex provider",
      async () => {
        const ctx = await createDaemonTestContext();
        try {
          // List models for Codex provider - no agent needed
          const result = await ctx.client.listProviderModels("codex");

          // Verify response structure
          expect(result.provider).toBe("codex");
          expect(result.error).toBeNull();
          expect(result.fetchedAt).toBeTruthy();

          // Should return at least one model
          expect(result.models).toBeTruthy();
          expect(result.models.length).toBeGreaterThan(0);

          // Verify model structure
          const model = result.models[0];
          expect(model.provider).toBe("codex");
          expect(model.id).toBeTruthy();
          expect(model.label).toBeTruthy();
        } finally {
          await ctx.cleanup();
        }
      },
      60000, // 1 minute timeout
    );

    test("returns model list for Claude provider", async () => {
      const ctx = await createDaemonTestContext();
      try {
        // List models for Claude provider - no agent needed
        const result = await ctx.client.listProviderModels("claude");

        // Verify response structure
        expect(result.provider).toBe("claude");
        expect(result.error).toBeNull();
        expect(result.fetchedAt).toBeTruthy();

        // Should return at least one model
        expect(result.models).toBeTruthy();
        expect(result.models.length).toBeGreaterThan(0);

        // Verify model structure
        const model = result.models[0];
        expect(model.provider).toBe("claude");
        expect(model.id).toBeTruthy();
        expect(model.label).toBeTruthy();
      } finally {
        await ctx.cleanup();
      }
    }, 180000);

    test.runIf(hasOpenCode)(
      "returns model list for OpenCode provider",
      async () => {
        const ctx = await createDaemonTestContext();
        try {
          const result = await ctx.client.listProviderModels("opencode");

          expect(result.provider).toBe("opencode");
          expect(result.error).toBeNull();
          expect(result.fetchedAt).toBeTruthy();

          expect(result.models).toBeTruthy();
          expect(result.models.length).toBeGreaterThan(0);

          const model = result.models[0];
          expect(model.provider).toBe("opencode");
          expect(model.id).toBeTruthy();
          expect(model.label).toBeTruthy();
        } finally {
          await ctx.cleanup();
        }
      },
      60000,
    );
  });
});
