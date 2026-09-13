import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { claudeNativeHistory } from "../test-utils/native-provider-history.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentSession } from "./agent-sdk-types.js";

test("real Claude history restores only the surviving last completed turn after prime, force and new manager", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "completed-evidence-"));
  const logger = createTestLogger();
  const native: unknown[] = [
    {
      type: "user",
      uuid: "native-prompt",
      message: { role: "user", content: "Respond with exactly: Ready JSON" },
    },
    {
      type: "assistant",
      uuid: "native-answer",
      message: { role: "assistant", content: [{ type: "text", text: "Ready JSON" }] },
    },
  ];
  const client = createTestAgentClient("claude");
  const wrap = (session: AgentSession) => {
    session.streamHistory = async function* () {
      yield* await claudeNativeHistory(native);
    };
    return session;
  };
  const create = client.createSession.bind(client),
    resume = client.resumeSession.bind(client);
  client.createSession = async (...args) => wrap(await create(...args));
  client.resumeSession = async (...args) => wrap(await resume(...args));
  const storage = new AgentStorage(directory, logger);
  const manager = new AgentManager({ registry: storage, clients: { claude: client }, logger });
  const nextStorage = new AgentStorage(directory, logger);
  const next = new AgentManager({ registry: nextStorage, clients: { claude: client }, logger });
  const agent = await manager.createAgent({ provider: "claude", cwd: directory }, undefined, {});
  try {
    expect((await claudeNativeHistory(native)).every((event) => !event.turnId)).toBe(true);
    // The first live turn has no history to replay. Its completion is the durable witness.
    await manager.runAgent(agent.id, "Respond with exactly: Ready JSON", {
      clientMessageId: "workflow:router:prompt",
    });
    const turnId = manager.getAgent(agent.id)!.lastCompletedTurnId!;
    await manager.hydrateTimelineFromProvider(agent.id, { force: true });
    expect((await manager.getTimelineRows(agent.id)).map((row) => row.turnId)).toEqual([
      turnId,
      turnId,
    ]);
    await manager.closeAgent(agent.id);
    await ensureAgentLoaded(agent.id, { agentManager: next, agentStorage: nextStorage, logger });
    expect((await next.getTimelineRows(agent.id)).map((row) => row.turnId)).toEqual([
      turnId,
      turnId,
    ]);
    expect(next.getTimeline(agent.id)[0]).toMatchObject({
      clientMessageId: "workflow:router:prompt",
    });
    const original = structuredClone(native);
    for (const changed of [
      original.slice(0, 1),
      [
        original[0],
        { type: "assistant", message: { role: "assistant", content: "Changed answer" } },
      ],
      [
        ...original,
        { type: "user", uuid: "next-prompt", message: { role: "user", content: "New turn" } },
      ],
      [...original, ...original],
    ]) {
      native.splice(0, native.length, ...changed);
      await next.hydrateTimelineFromProvider(agent.id, { force: true });
      expect((await next.getTimelineRows(agent.id)).every((row) => !row.turnId)).toBe(true);
    }
    expect(JSON.stringify((await storage.get(agent.id))?.lastCompletedTurnEvidence)).not.toContain(
      "Ready JSON",
    );
  } finally {
    await manager.closeAgent(agent.id);
    await next.closeAgent(agent.id);
    await rm(directory, { recursive: true, force: true });
  }
});
