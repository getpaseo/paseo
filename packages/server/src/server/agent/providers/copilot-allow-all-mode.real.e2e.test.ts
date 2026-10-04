import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { asInternals } from "../../test-utils/class-mocks.js";
import {
  canRunRealProvider,
  createRealProviderClient,
  getRealProviderConfig,
} from "../../daemon-e2e/real-provider-test-config.js";
import { COPILOT_ALLOW_ALL_MODE_ID } from "./copilot-acp-agent.js";

const AGENT_MODE_ID = "https://agentclientprotocol.com/protocol/session-modes#agent";
const PLAN_MODE_ID = "https://agentclientprotocol.com/protocol/session-modes#plan";

interface CopilotSessionInternals {
  sessionId: string;
  connection: {
    setSessionConfigOption(input: {
      sessionId: string;
      configId: string;
      value: string;
    }): Promise<{ configOptions: SessionConfigOption[] }>;
  };
}

interface LiveCopilotState {
  mode: string | undefined;
  allowAll: string | undefined;
}

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "copilot-allow-all-real-"));
}

function currentValueOf(options: SessionConfigOption[], id: string): string | undefined {
  const option = options.find((candidate) => candidate.id === id);
  return option?.type === "select" ? option.currentValue : undefined;
}

// Paseo applies its mode writes to the session optimistically, and its Copilot
// transformer reports Allow All whenever allow_all is on, whatever mode the
// session is really in. Both hide the state this test exists to catch, so read
// what Copilot itself reports: a no-op config write whose response carries the
// agent's current, untransformed configuration.
async function readLiveCopilotState(session: unknown): Promise<LiveCopilotState> {
  const internals = asInternals<CopilotSessionInternals>(session);
  const response = await internals.connection.setSessionConfigOption({
    sessionId: internals.sessionId,
    configId: "reasoning_effort",
    value: "medium",
  });
  return {
    mode: currentValueOf(response.configOptions, "mode"),
    allowAll: currentValueOf(response.configOptions, "allow_all"),
  };
}

describe("Copilot ACP provider (real) Allow All mode", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("copilot");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  // The headline bug: allow_all and mode are independent Copilot config options,
  // so granting permissions never moved the session out of plan mode. Copilot
  // kept framing its instructions as a plan and refused to edit anything.
  test("selecting Allow All from plan mode leaves plan mode", async () => {
    const cwd = tmpCwd();
    const client = createRealProviderClient("copilot", createTestLogger());

    try {
      const session = await client.createSession({ ...getRealProviderConfig("copilot"), cwd });

      try {
        await session.setMode(PLAN_MODE_ID);
        await expect(session.getCurrentMode()).resolves.toBe(PLAN_MODE_ID);

        await session.setMode(COPILOT_ALLOW_ALL_MODE_ID);

        const live = await readLiveCopilotState(session);
        expect(live).toEqual({ mode: AGENT_MODE_ID, allowAll: "on" });
      } finally {
        await session.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 240_000);
});
