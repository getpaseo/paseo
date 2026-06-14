import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "./config.js";

function withTempPaseoHome(run: (paseoHome: string) => void): void {
  const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-config-test-"));
  try {
    run(paseoHome);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
  }
}

describe("loadConfig", () => {
  test("injects the agent MCP server by default", () => {
    withTempPaseoHome((paseoHome) => {
      expect(loadConfig(paseoHome, { env: {} }).mcpInjectIntoAgents).toBe(true);
    });
  });

  test("respects persisted opt-out for agent MCP injection", () => {
    withTempPaseoHome((paseoHome) => {
      writeFileSync(
        path.join(paseoHome, "config.json"),
        `${JSON.stringify({ daemon: { mcp: { injectIntoAgents: false } } }, null, 2)}\n`,
        "utf8",
      );

      expect(loadConfig(paseoHome, { env: {} }).mcpInjectIntoAgents).toBe(false);
    });
  });
});
