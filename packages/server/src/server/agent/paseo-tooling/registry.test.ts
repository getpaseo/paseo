import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createPaseoToolRegistry } from "./registry.js";

describe("Paseo tooling registry", () => {
  test("executes tools with runtime caller identity", async () => {
    const callerCwd = mkdtempSync(path.join(os.tmpdir(), "paseo-tooling-caller-"));
    const requestedCwd = path.join(callerCwd, "child");
    const createdTerminals: Array<{ cwd: string; name?: string }> = [];
    const terminalManager = {
      createTerminal: async (input: { cwd: string; name?: string }) => {
        createdTerminals.push(input);
        return { id: "terminal-1", name: input.name ?? "Terminal", cwd: input.cwd };
      },
    };
    const agentManager = {
      getAgent: (agentId: string) =>
        agentId === "agent-1" ? { cwd: callerCwd, config: {} } : undefined,
    };

    try {
      const registry = createPaseoToolRegistry({
        agentManager: agentManager as never,
        agentStorage: {} as never,
        terminalManager: terminalManager as never,
        providerSnapshotManager: {} as never,
        agentScopedTools: true,
        logger: createTestLogger(),
      });

      const result = await registry.executeTool({
        name: "create_terminal",
        callerAgentId: "agent-1",
        input: {
          cwd: "child",
          name: "Build",
        },
      });

      expect(createdTerminals).toEqual([{ cwd: requestedCwd, name: "Build" }]);
      expect(result.structuredContent).toEqual({
        id: "terminal-1",
        name: "Build",
        cwd: requestedCwd,
      });
    } finally {
      rmSync(callerCwd, { recursive: true, force: true });
    }
  });
});
