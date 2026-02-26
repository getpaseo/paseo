import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getOrCreateServerId } from "./server-id.js";

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "junction-server-id-"));
}

describe("getOrCreateServerId", () => {
  let home: string;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.JUNCTION_SERVER_ID;
    home = tmpHome();
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(home, { recursive: true, force: true });
  });

  it("creates and persists a stable id per JUNCTION_HOME", () => {
    const first = getOrCreateServerId(home);
    const second = getOrCreateServerId(home);
    expect(first).toBe(second);
    expect(first.startsWith("srv_")).toBe(true);

    const idPath = path.join(home, "server-id");
    expect(existsSync(idPath)).toBe(true);
    expect(readFileSync(idPath, "utf8").trim()).toBe(first);
  });

  it("respects and persists JUNCTION_SERVER_ID override", () => {
    process.env.JUNCTION_SERVER_ID = "test-daemon-id";
    const id = getOrCreateServerId(home);
    expect(id).toBe("test-daemon-id");

    const idPath = path.join(home, "server-id");
    expect(existsSync(idPath)).toBe(true);
    expect(readFileSync(idPath, "utf8").trim()).toBe("test-daemon-id");
  });
});

