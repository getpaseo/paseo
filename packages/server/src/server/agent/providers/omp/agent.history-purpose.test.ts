import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentClient, AgentPersistenceHandle } from "../../agent-sdk-types.js";
import { OmpAgentClient, OmpAgentSession } from "./agent.js";
import { FakeOmp } from "./test-utils/fake-omp.js";

const CWD = "/tmp/paseo-omp-history-purpose-test";

async function writeOmpHistoryFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-omp-history-purpose-"));
  const sessionFile = join(directory, "session.jsonl");
  const entries = [
    { type: "session", id: "session-root", parentId: null },
    {
      type: "message",
      id: "user-history",
      parentId: "session-root",
      message: { role: "user", content: "continue the audit" },
    },
    {
      type: "message",
      id: "assistant-history",
      parentId: "user-history",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "audit context restored" }],
        responseId: "assistant-history",
      },
    },
  ];
  await writeFile(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
  return sessionFile;
}

describe("OMP resumeSession purpose: history", () => {
  test("starts no runtime and still reads history from the session file", async () => {
    const omp = new FakeOmp();
    const client: AgentClient = new OmpAgentClient({
      logger: createTestLogger(),
      runtime: omp,
    });
    const sessionFile = await writeOmpHistoryFile();
    const handle: AgentPersistenceHandle = {
      provider: "omp",
      sessionId: "omp-history-session-1",
      nativeHandle: sessionFile,
      metadata: { cwd: CWD },
    };

    const session = await client.resumeSession(handle, undefined, undefined, {
      purpose: "history",
    });

    try {
      // The mutant: restoring the unconditional `runtime.startSession` call
      // for a history-purpose resume makes this assertion fail with a
      // recorded launch.
      expect(omp.recordedLaunches).toHaveLength(0);
      expect(session).not.toBeInstanceOf(OmpAgentSession);

      const events = [];
      for await (const event of session.streamHistory()) {
        events.push(event);
      }
      expect(events).toEqual([
        {
          type: "timeline",
          provider: "omp",
          item: { type: "user_message", text: "continue the audit", messageId: "user-history" },
        },
        {
          type: "timeline",
          provider: "omp",
          item: {
            type: "assistant_message",
            text: "audit context restored",
            messageId: "assistant-history",
          },
        },
      ]);
    } finally {
      await session.close();
    }

    // close() on a history-purpose session has no runtime to release.
    expect(omp.recordedLaunches).toHaveLength(0);
  });

  test("an interactive resume (no purpose) still starts a runtime", async () => {
    const omp = new FakeOmp();
    const client: AgentClient = new OmpAgentClient({
      logger: createTestLogger(),
      runtime: omp,
    });
    const sessionFile = await writeOmpHistoryFile();
    const handle: AgentPersistenceHandle = {
      provider: "omp",
      sessionId: "omp-interactive-session-1",
      nativeHandle: sessionFile,
      metadata: { cwd: CWD },
    };

    const session = await client.resumeSession(handle);
    try {
      expect(omp.recordedLaunches).toHaveLength(1);
      expect(session).toBeInstanceOf(OmpAgentSession);
    } finally {
      await session.close();
    }
  });
});
