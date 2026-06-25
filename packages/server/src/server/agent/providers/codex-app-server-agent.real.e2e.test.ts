import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  canRunRealProvider,
  createRealProviderClient,
  getRealProviderConfig,
} from "../../daemon-e2e/real-provider-test-config.js";

describe("Codex app-server provider (real)", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("codex");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("lists models and runs a simple prompt", async () => {
    const client = createRealProviderClient("codex", createTestLogger());
    const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-app-server-e2e-"));
    const { models } = await client.fetchCatalog({ cwd, force: false });
    expect(models.length).toBeGreaterThan(0);

    const session = await client.createSession({
      ...getRealProviderConfig("codex"),
      cwd,
      modeId: "auto",
    });
    try {
      expect(session.features?.some((feature) => feature.id === "plan_mode")).toBe(true);

      const result = await session.run("Say hello in one sentence.");
      expect(result.finalText.length).toBeGreaterThan(0);
    } finally {
      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
