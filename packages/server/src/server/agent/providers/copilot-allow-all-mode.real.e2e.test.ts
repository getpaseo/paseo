import { beforeAll, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

import { isCommandAvailable } from "../../../executable-resolution/executable-resolution.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";
import { resolveACPModeSelection } from "./acp-agent.js";
import {
  COPILOT_ALLOW_ALL_MODE_ID,
  COPILOT_MODES,
  writeCopilotProviderMode,
} from "./copilot-acp-agent.js";

const AGENT_MODE_ID = "https://agentclientprotocol.com/protocol/session-modes#agent";
const PLAN_MODE_ID = "https://agentclientprotocol.com/protocol/session-modes#plan";

describe("Copilot ACP provider (real) Allow All mode", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isCommandAvailable("copilot");
  });

  test("selecting Allow All from Plan leaves the real provider in Agent mode", async (context) => {
    if (!canRun) {
      context.skip();
    }
    const cwd = await mkdtemp(join(tmpdir(), "copilot-allow-all-real-"));
    const child = spawn("copilot", ["--acp"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      }),
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
    );

    try {
      await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const session = await connection.newSession({ cwd, mcpServers: [] });
      const plan = await connection.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "mode",
        value: PLAN_MODE_ID,
      });
      expect(plan.configOptions).toContainEqual(
        expect.objectContaining({ id: "mode", currentValue: PLAN_MODE_ID }),
      );

      // This is the same provider writer called by ACPAgentSession. Assert its
      // untransformed ACP response, since Paseo's displayed mode hides this bug.
      const result = await writeCopilotProviderMode({
        connection,
        sessionId: session.sessionId,
        requestedModeId: COPILOT_ALLOW_ALL_MODE_ID,
        currentModeId: PLAN_MODE_ID,
        selection: resolveACPModeSelection({
          modeId: COPILOT_ALLOW_ALL_MODE_ID,
          availableModes: COPILOT_MODES,
          configOptions: plan.configOptions,
        }),
        configOptions: plan.configOptions,
        logger: createTestLogger(),
      });

      expect(result.configOptions).toContainEqual(
        expect.objectContaining({ id: "mode", currentValue: AGENT_MODE_ID }),
      );
      expect(result.configOptions).toContainEqual(
        expect.objectContaining({ id: "allow_all", currentValue: "on" }),
      );
    } finally {
      await terminateWithTreeKill(child, { gracefulTimeoutMs: 1000, forceTimeoutMs: 1000 });
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
