import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import {
  canRunRealProvider,
  createRealProviderClient,
  getRealProviderConfig,
} from "../../../daemon-e2e/real-provider-test-config.js";
import type { MuseAgentClient } from "./agent.js";

describe("Muse provider (real)", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("muse");
  });

  function createClient(): MuseAgentClient {
    return createRealProviderClient("muse", createTestLogger()) as MuseAgentClient;
  }

  test("lists models and runs a simple prompt", async (context) => {
    if (!canRun) {
      context.skip();
    }
    const client = createClient();
    const cwd = mkdtempSync(path.join(os.tmpdir(), "muse-e2e-"));
    try {
      const { models } = await client.fetchCatalog({ scope: "workspace", cwd, force: false });
      expect(models.length).toBeGreaterThan(0);
      const session = await client.createSession({
        ...getRealProviderConfig("muse"),
        cwd,
      });
      try {
        const result = await session.run("Reply with exactly MUSE_SENTINEL and nothing else.");
        expect(result.finalText).toContain("MUSE_SENTINEL");
      } finally {
        await session.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("lists importable sessions", async (context) => {
    if (!canRun) {
      context.skip();
    }
    const rows = await createClient().listImportableSessions({ limit: 5 });
    expect(Array.isArray(rows)).toBe(true);
  }, 60_000);
});
