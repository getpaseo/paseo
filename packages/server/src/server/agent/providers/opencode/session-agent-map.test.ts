import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { SESSION_MAP_FILE_NAME, SessionAgentMap } from "./session-agent-map.js";

describe("SessionAgentMap", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "paseo-session-map-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("persists entries atomically to opencode-session-map.json", () => {
    const map = new SessionAgentMap({ paseoHome: tmpHome });
    map.set("session-a", "agent-a");
    map.set("session-b", "agent-b");

    const filePath = join(tmpHome, SESSION_MAP_FILE_NAME);
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, string>;
    expect(parsed).toEqual({ "session-a": "agent-a", "session-b": "agent-b" });
  });

  test("rehydrates state from disk on construction", () => {
    writeFileSync(
      join(tmpHome, SESSION_MAP_FILE_NAME),
      JSON.stringify({ "session-x": "agent-x" }),
      "utf8",
    );

    const map = new SessionAgentMap({ paseoHome: tmpHome });
    expect(map.get("session-x")).toBe("agent-x");
    expect(map.size()).toBe(1);
  });

  test("removes file after clear()", () => {
    const map = new SessionAgentMap({ paseoHome: tmpHome });
    map.set("session-a", "agent-a");
    map.clear();

    expect(existsSync(join(tmpHome, SESSION_MAP_FILE_NAME))).toBe(false);
    expect(map.get("session-a")).toBeUndefined();
  });

  test("delete() removes entry and persists", () => {
    const map = new SessionAgentMap({ paseoHome: tmpHome });
    map.set("session-a", "agent-a");
    map.set("session-b", "agent-b");
    map.delete("session-a");

    const parsed = JSON.parse(readFileSync(join(tmpHome, SESSION_MAP_FILE_NAME), "utf8")) as Record<
      string,
      string
    >;
    expect(parsed).toEqual({ "session-b": "agent-b" });
  });

  test("ignores corrupted JSON and starts empty", () => {
    writeFileSync(join(tmpHome, SESSION_MAP_FILE_NAME), "{not-json]", "utf8");
    const map = new SessionAgentMap({ paseoHome: tmpHome });
    expect(map.size()).toBe(0);
  });

  test("ignores non-string values in persisted file", () => {
    writeFileSync(
      join(tmpHome, SESSION_MAP_FILE_NAME),
      JSON.stringify({ valid: "agent-a", bogus: 42, nested: { x: 1 } }),
      "utf8",
    );

    const map = new SessionAgentMap({ paseoHome: tmpHome });
    expect(map.snapshot()).toEqual({ valid: "agent-a" });
  });
});
