import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import {
  GROK_SESSION_UPDATE_METHOD,
  GrokACPAgentClient,
  mapGrokCompactionExtensionNotification,
} from "./grok-acp-agent.js";

const context = { sessionId: "session-1" };

describe("mapGrokCompactionExtensionNotification", () => {
  test("ignores extension methods and sessions it does not own", () => {
    expect(
      mapGrokCompactionExtensionNotification(
        "_other.ai/session/update",
        { sessionId: "session-1" },
        context,
      ),
    ).toBeNull();
    expect(
      mapGrokCompactionExtensionNotification(
        GROK_SESSION_UPDATE_METHOD,
        {
          sessionId: "session-2",
          update: { sessionUpdate: "auto_compact_started", tokens_used: 400_000 },
        },
        context,
      ),
    ).toEqual([]);
  });

  test("maps Grok auto-compaction start and completion into the shared marker", () => {
    expect(
      mapGrokCompactionExtensionNotification(
        GROK_SESSION_UPDATE_METHOD,
        {
          sessionId: "session-1",
          update: {
            sessionUpdate: "auto_compact_started",
            tokens_used: 423_901,
            context_window: 500_000,
            percentage: 85,
            reason: "Context window 85% full",
          },
        },
        context,
      ),
    ).toEqual([
      {
        type: "compaction",
        status: "loading",
        trigger: "auto",
      },
    ]);

    expect(
      mapGrokCompactionExtensionNotification(
        GROK_SESSION_UPDATE_METHOD,
        {
          sessionId: "session-1",
          update: {
            sessionUpdate: "auto_compact_completed",
            tokens_before: 423_901,
            tokens_after: 18_914,
            elapsed_ms: 151_577,
            summary_preview: null,
          },
        },
        context,
      ),
    ).toEqual([
      {
        type: "compaction",
        status: "completed",
        trigger: "auto",
      },
    ]);
  });

  test("settles failed and canceled compactions without leaving a loading marker", () => {
    expect(
      mapGrokCompactionExtensionNotification(
        GROK_SESSION_UPDATE_METHOD,
        {
          sessionId: "session-1",
          update: { sessionUpdate: "auto_compact_failed" },
        },
        context,
      ),
    ).toEqual([
      {
        type: "compaction",
        status: "completed",
        trigger: "auto",
      },
    ]);
    expect(
      mapGrokCompactionExtensionNotification(
        GROK_SESSION_UPDATE_METHOD,
        {
          sessionId: "session-1",
          update: { sessionUpdate: "auto_compact_cancelled" },
        },
        context,
      ),
    ).toEqual([
      {
        type: "compaction",
        status: "completed",
        trigger: "auto",
      },
    ]);
  });

  test("ignores checkpoints and unknown updates", () => {
    expect(
      mapGrokCompactionExtensionNotification(
        GROK_SESSION_UPDATE_METHOD,
        {
          sessionId: "session-1",
          update: { sessionUpdate: "compaction_checkpoint", checkpoint_id: "checkpoint-1" },
        },
        context,
      ),
    ).toEqual([]);
    expect(
      mapGrokCompactionExtensionNotification(
        GROK_SESSION_UPDATE_METHOD,
        { sessionId: "session-1", update: { sessionUpdate: "something_else" } },
        context,
      ),
    ).toEqual([]);
  });
});

test("replays Grok compaction extension notifications from session/load into history", async () => {
  await withFakeGrokACPAgent(async (testDir, scriptPath) => {
    const client = new GrokACPAgentClient({
      logger: createTestLogger(),
      command: [process.execPath, scriptPath],
    });
    const session = await client.resumeSession(
      { provider: "acp", sessionId: "grok-session-1" },
      { cwd: testDir },
    );

    try {
      const history: AgentStreamEvent[] = [];
      for await (const event of session.streamHistory()) {
        history.push(event);
      }

      expect(history).toEqual([
        {
          type: "timeline",
          provider: "acp",
          item: {
            type: "compaction",
            status: "loading",
            trigger: "auto",
          },
        },
        {
          type: "timeline",
          provider: "acp",
          item: {
            type: "compaction",
            status: "completed",
            trigger: "auto",
          },
        },
      ]);
    } finally {
      await session.close();
    }
  });
});

async function withFakeGrokACPAgent(
  run: (testDir: string, scriptPath: string) => Promise<void>,
): Promise<void> {
  const testDir = await mkdtemp(path.join(tmpdir(), "paseo-grok-acp-history-"));
  try {
    const scriptPath = path.join(testDir, "fake-grok-acp-agent.cjs");
    await writeFile(scriptPath, fakeGrokACPAgentScript, "utf8");
    await run(testDir, scriptPath);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

const fakeGrokACPAgentScript = `
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

function notify(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: message.params?.protocolVersion ?? 1,
      agentCapabilities: { loadSession: true },
    });
    return;
  }

  if (message.method === "session/load") {
    notify("_x.ai/session/update", {
      sessionId: "grok-session-1",
      update: { sessionUpdate: "auto_compact_started", tokens_used: 423901 },
    });
    notify("_x.ai/session/update", {
      sessionId: "grok-session-1",
      update: { sessionUpdate: "compaction_checkpoint" },
    });
    notify("_x.ai/session/update", {
      sessionId: "grok-session-1",
      update: { sessionUpdate: "auto_compact_completed", tokens_before: 423901 },
    });
    send(message.id, { configOptions: [], modes: null, models: null });
  }
});
`;
