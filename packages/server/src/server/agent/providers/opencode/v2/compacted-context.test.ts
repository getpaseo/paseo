import type { SessionMessageInfo } from "@opencode/client";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { OpenCodeV2AgentClient } from "./agent.js";

async function resumed(history: unknown[]) {
  const harness = new V2Harness();
  harness.history.push(...(history as SessionMessageInfo[]));
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  return client.resumeSession({
    provider: "opencode",
    sessionId: "session",
    metadata: { cwd: "/tmp/project" },
  });
}

const compaction = (status: string, fields: Record<string, unknown> = {}) => ({
  id: `compaction-${status}`,
  type: "compaction",
  status,
  reason: "manual",
  time: { created: 2 },
  ...fields,
});

test("reads OpenCode's own completed compaction, also without the recent part", async () => {
  // OpenCode 2.1.4 stores a completed compaction without `recent` when it kept nothing.
  const session = await resumed([
    { id: "old", type: "user", text: "Earlier prompt", time: { created: 1 } },
    compaction("completed", { summary: "  The user wants PLOVER kept.  " }),
  ]);
  try {
    expect(await session.readCompactedContext?.()).toBe("The user wants PLOVER kept.");
  } finally {
    await session.close();
  }
});

test("joins the summary and the recent part", async () => {
  const session = await resumed([
    compaction("completed", { summary: "Summary.", recent: "Recent messages." }),
  ]);
  try {
    expect(await session.readCompactedContext?.()).toBe("Summary.\n\nRecent messages.");
  } finally {
    await session.close();
  }
});

test("a newest compaction that did not complete gives no summary", async () => {
  const session = await resumed([
    compaction("completed", { summary: "Older summary." }),
    { ...compaction("failed", { error: { message: "context overflow" } }), id: "later" },
  ]);
  try {
    expect(await session.readCompactedContext?.()).toBeNull();
  } finally {
    await session.close();
  }
});
