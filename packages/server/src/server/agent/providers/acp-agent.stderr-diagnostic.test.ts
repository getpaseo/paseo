import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { ACPAgentSession } from "./acp-agent.js";

/**
 * A turn the ACP server rejects has to reach `daemon.log` with something that
 * explains it. The server's own stderr is the only such thing for a
 * closed-source wrapper, so it travels in the failed turn's diagnostic (#4757).
 *
 * Driven through a spawned agent rather than the session's internals: the wiring
 * under test is `child.stderr` reaching the diagnostic, which a direct call
 * would skip.
 */
const FAKE_AGENT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, { protocolVersion: message.params?.protocolVersion ?? 1, agentCapabilities: {} });
    return;
  }
  if (message.method === "session/new") {
    reply(message.id, { sessionId: "session-1" });
    return;
  }
  if (message.method === "session/prompt") {
    process.stderr.write("could not find doneCh for checkpoint\\n");
    setTimeout(() => {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Agent execution error" } }) + "\\n",
      );
    }, 10);
    return;
  }
  if (message.id !== undefined) reply(message.id, {});
});
`;

async function withFakeAgent(
  run: (scriptPath: string, cwd: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "paseo-acp-stderr-"));
  try {
    const scriptPath = path.join(dir, "fake-acp-agent.cjs");
    await writeFile(scriptPath, FAKE_AGENT, "utf8");
    await run(scriptPath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The first `turn_failed` the session emits. */
function nextTurnFailure(
  session: ACPAgentSession,
): Promise<Extract<AgentStreamEvent, { type: "turn_failed" }>> {
  return new Promise((resolve) => {
    session.subscribe((event) => {
      if (event.type === "turn_failed") resolve(event);
    });
  });
}

function createSession(scriptPath: string, cwd: string): ACPAgentSession {
  return new ACPAgentSession(
    { provider: "claude-acp", cwd },
    {
      provider: "claude-acp",
      logger: createTestLogger(),
      defaultCommand: [process.execPath, scriptPath],
      defaultModes: [],
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: true,
      },
    },
  );
}

describe("ACP turn failure diagnostics", () => {
  test("a rejected turn carries what the server wrote on stderr", async () => {
    await withFakeAgent(async (scriptPath, cwd) => {
      const session = createSession(scriptPath, cwd);
      await session.initializeNewSession();
      const failed = nextTurnFailure(session);

      try {
        await session.startTurn("hello");
        expect((await failed).diagnostic).toContain("could not find doneCh for checkpoint");
      } finally {
        await session.close();
      }
    });
  }, 20_000);
});
