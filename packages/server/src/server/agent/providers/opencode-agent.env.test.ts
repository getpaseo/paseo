import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeServerManager } from "./opencode-agent.js";
import { SESSION_MAP_FILE_NAME } from "./opencode/session-agent-map.js";

describe("OpenCodeServerManager session identity bridge", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "opencode-agent-env-"));
    vi.stubEnv("PASEO_HOME", tmpHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("registerSession persists sessionId -> agentId mapping", () => {
    const manager = OpenCodeServerManager.createForTesting(createTestLogger());
    manager.registerSession("opencode-session-1", "paseo-agent-1");
    manager.registerSession("opencode-session-2", "paseo-agent-2");

    expect(manager.getAgentIdForSession("opencode-session-1")).toBe("paseo-agent-1");
    expect(manager.getAgentIdForSession("opencode-session-2")).toBe("paseo-agent-2");

    const filePath = join(tmpHome, SESSION_MAP_FILE_NAME);
    expect(existsSync(filePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, string>;
    expect(persisted).toEqual({
      "opencode-session-1": "paseo-agent-1",
      "opencode-session-2": "paseo-agent-2",
    });
  });

  test("unregisterSession removes entry from map", () => {
    const manager = OpenCodeServerManager.createForTesting(createTestLogger());
    manager.registerSession("opencode-session-1", "paseo-agent-1");
    manager.registerSession("opencode-session-2", "paseo-agent-2");
    manager.unregisterSession("opencode-session-1");

    expect(manager.getAgentIdForSession("opencode-session-1")).toBeUndefined();
    expect(manager.getAgentIdForSession("opencode-session-2")).toBe("paseo-agent-2");

    const persisted = JSON.parse(
      readFileSync(join(tmpHome, SESSION_MAP_FILE_NAME), "utf8"),
    ) as Record<string, string>;
    expect(persisted).toEqual({ "opencode-session-2": "paseo-agent-2" });
  });

  test("registerSession ignores empty ids", () => {
    const manager = OpenCodeServerManager.createForTesting(createTestLogger());
    manager.registerSession("", "agent");
    manager.registerSession("session", "");
    expect(manager.getAgentIdForSession("")).toBeUndefined();
    expect(manager.getAgentIdForSession("session")).toBeUndefined();
  });

  test("unregisterSession tolerates null/undefined sessionId", () => {
    const manager = OpenCodeServerManager.createForTesting(createTestLogger());
    expect(() => manager.unregisterSession(null)).not.toThrow();
    expect(() => manager.unregisterSession(undefined)).not.toThrow();
  });

  test("two managers sharing the same PASEO_HOME observe each other's writes", () => {
    const managerA = OpenCodeServerManager.createForTesting(createTestLogger());
    managerA.registerSession("shared-session", "agent-x");

    const managerB = OpenCodeServerManager.createForTesting(createTestLogger());
    expect(managerB.getAgentIdForSession("shared-session")).toBe("agent-x");
  });

  test("sessionMapPath points to $PASEO_HOME/opencode-session-map.json", () => {
    const manager = OpenCodeServerManager.createForTesting(createTestLogger());
    expect(manager.sessionMapPath).toBe(join(tmpHome, SESSION_MAP_FILE_NAME));
  });
});
