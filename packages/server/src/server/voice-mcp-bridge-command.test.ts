import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  resolveVoiceMcpBridgeFromRuntime,
  resolveVoiceMcpBridgeScriptPath,
} from "./voice-mcp-bridge-command.js";

describe("resolveVoiceMcpBridgeFromRuntime", () => {
  const bootstrapModuleUrl = new URL("./bootstrap.ts", import.meta.url).toString();

  test("resolves default JS bridge script with node execPath", () => {
    const result = resolveVoiceMcpBridgeFromRuntime({
      bootstrapModuleUrl,
      execPath: "/usr/local/bin/node",
    });

    const expectedScriptPath = fileURLToPath(
      new URL("../../scripts/mcp-stdio-socket-bridge-cli.mjs", bootstrapModuleUrl)
    );

    expect(result.source).toBe("default-js-script");
    expect(result.resolved.command).toBe("/usr/local/bin/node");
    expect(result.resolved.baseArgs).toEqual([expectedScriptPath]);
  });

  test("uses explicit script override when provided", () => {
    const explicitScriptPath = fileURLToPath(
      new URL("../../scripts/mcp-stdio-socket-bridge-cli.mjs", bootstrapModuleUrl)
    );

    const result = resolveVoiceMcpBridgeFromRuntime({
      bootstrapModuleUrl,
      execPath: "/usr/local/bin/node",
      explicitScriptPath,
    });

    expect(result.source).toBe("explicit-js-script");
    expect(result.resolved.command).toBe("/usr/local/bin/node");
    expect(result.resolved.baseArgs).toEqual([explicitScriptPath]);
  });

  test("throws when explicit script path is missing", () => {
    expect(() =>
      resolveVoiceMcpBridgeScriptPath({
        bootstrapModuleUrl,
        explicitScriptPath: "/tmp/does-not-exist-voice-bridge-script.mjs",
      })
    ).toThrow("MCP stdio-socket bridge script not found");
  });
});
