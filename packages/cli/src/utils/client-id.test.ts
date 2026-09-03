import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Imported before PASEO_HOME is set, so the first assertion below only passes if
// the client-id path is resolved when the function runs.
import { getOrCreateCliClientId } from "./client-id.js";

describe("getOrCreateCliClientId", () => {
  let scratch: string;
  const originalPaseoHome = process.env.PASEO_HOME;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "paseo-cli-client-id-"));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = originalPaseoHome;
  });

  test("writes the client id under PASEO_HOME set after module load", async () => {
    const home = join(scratch, "home");
    process.env.PASEO_HOME = home;

    const clientId = await getOrCreateCliClientId();

    expect(clientId).toMatch(/^cid_[0-9a-f]{32}$/);
    expect(readFileSync(join(home, "cli-client-id"), "utf8")).toBe(clientId);
  });

  test("expands a leading tilde in PASEO_HOME", async () => {
    const relative = join(".paseo-cli-client-id-test", "home");
    process.env.PASEO_HOME = `~/${relative}`;
    const expanded = join(homedir(), relative);

    vi.resetModules();
    const { getOrCreateCliClientId: freshGetOrCreate } = await import("./client-id.js");

    try {
      const clientId = await freshGetOrCreate();
      expect(readFileSync(join(expanded, "cli-client-id"), "utf8")).toBe(clientId);
    } finally {
      rmSync(join(homedir(), ".paseo-cli-client-id-test"), { recursive: true, force: true });
    }
  });
});
