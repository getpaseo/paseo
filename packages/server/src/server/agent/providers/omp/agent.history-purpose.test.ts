import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentPersistenceHandle } from "../../agent-sdk-types.js";
import { OmpAgentClient } from "./agent.js";
import { FakeOmp } from "./test-utils/fake-omp.js";

test("archived OMP history replays messages and todos without leaving a runtime", async () => {
  // The todo snapshot comes last; it must carry the session's time, not the time of this
  // replay, or the last turn's footer reads "Worked for <days>" ending now.
  const directory = await mkdtemp(join(tmpdir(), "paseo-omp-history-purpose-"));
  const sessionFile = join(directory, "session.jsonl");
  const entries = [
    { type: "session", id: "root", parentId: null },
    {
      type: "message",
      id: "user-1",
      parentId: "root",
      timestamp: "2026-11-07T11:30:00.000Z",
      message: { role: "user", content: "make a plan" },
    },
    {
      type: "message",
      id: "todo-1",
      parentId: "user-1",
      timestamp: "2026-11-07T11:31:00.000Z",
      message: {
        role: "toolResult",
        toolName: "todo",
        toolCallId: "call-1",
        content: [{ type: "text", text: "one task" }],
        details: {
          phases: [{ name: "Tasks", tasks: [{ content: "Check history", status: "pending" }] }],
        },
      },
    },
    {
      type: "message",
      id: "answer-1",
      parentId: "todo-1",
      timestamp: "2026-11-07T11:32:16.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Plan ready." }] },
    },
  ];
  await writeFile(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  const runtime = new FakeOmp();
  const client = new OmpAgentClient({ logger: createTestLogger(), runtime });
  const handle: AgentPersistenceHandle = {
    provider: "omp",
    sessionId: "history-1",
    nativeHandle: sessionFile,
    metadata: { cwd: directory },
  };

  const session = await client.resumeSession(handle, undefined, undefined, { purpose: "history" });
  const events = [];
  try {
    for await (const event of session.streamHistory()) events.push(event);
  } finally {
    await session.close();
  }

  expect(runtime.recordedLaunches).toHaveLength(0);
  expect(events).toContainEqual({
    type: "timeline",
    provider: "omp",
    item: {
      type: "todo",
      items: [{ text: "Check history", status: "pending", completed: false }],
    },
    timestamp: "2026-11-07T11:32:16.000Z",
  });
});
