import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const roots: string[] = [];
const staticDirs: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ...staticDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  ]);
});

async function closeWithoutCleanup(daemon: TestPaseoDaemon): Promise<void> {
  staticDirs.push(daemon.staticDir);
  await daemon.close();
}

test("recovers interrupted agents during daemon startup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-bootstrap-agent-recovery-"));
  roots.push(root);

  const first = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  const agent = await first.daemon.agentManager.createAgent(
    { provider: "codex", cwd: root },
    "11111111-1111-4111-8111-111111111111",
    { workspaceId: undefined },
  );
  await first.daemon.agentStorage.applySnapshot(agent);
  await closeWithoutCleanup(first);

  const record = await first.daemon.agentStorage.get(agent.id);
  if (!record) {
    throw new Error("Expected persisted agent record");
  }
  await first.daemon.agentStorage.upsert({
    ...record,
    lastStatus: "running",
    persistence: {
      provider: "codex",
      sessionId: "recovery-session",
      metadata: { cwd: root },
    },
  });

  const restarted = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  staticDirs.push(restarted.staticDir);
  try {
    expect(restarted.daemon.agentManager.getAgent(agent.id)?.persistence).toMatchObject({
      provider: "codex",
      sessionId: "recovery-session",
    });
  } finally {
    await restarted.close();
  }
});
