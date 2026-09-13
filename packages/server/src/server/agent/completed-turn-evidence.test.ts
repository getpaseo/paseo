import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { claudeNativeHistory, codexNativeHistory } from "../test-utils/native-provider-history.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentSession, AgentStreamEvent } from "./agent-sdk-types.js";
import {
  captureCompletedTurnEvidence,
  restoreCompletedTurnEvidence,
} from "./completed-turn-evidence.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

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
    const start = session.startTurn.bind(session);
    session.startTurn = async (prompt, options) => {
      const result = await start(prompt, options);
      (
        session as unknown as { notifySubscribers(event: AgentStreamEvent): void }
      ).notifySubscribers({
        type: "timeline",
        provider: "claude",
        turnId: result.turnId,
        item: {
          type: "user_message",
          text: String(prompt),
          messageId: "native-prompt",
          clientMessageId: options?.clientMessageId,
        },
      });
      return result;
    };
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
      [{ ...(original[0] as object), uuid: "replacement-prompt" }, original[1]],
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

test("native origin UUID is required independently of the surviving last prompt; legacy ambiguity gets no origin receipt", async () => {
  const native = [
    { type: "user", uuid: "origin", message: { role: "user", content: "Original review" } },
    { type: "assistant", uuid: "empty", message: { role: "assistant", content: "No conclusion" } },
    { type: "user", uuid: "retry", message: { role: "user", content: "Retry this review" } },
    {
      type: "assistant",
      uuid: "conclusion",
      message: { role: "assistant", content: "Objections" },
    },
  ];
  const history = await claudeNativeHistory(native);
  const rows = history.flatMap((event, seq): AgentTimelineRow[] =>
    event.type === "timeline"
      ? [
          {
            seq,
            timestamp: "",
            turnId: seq < 2 ? "first" : "last",
            item:
              event.item.type === "user_message"
                ? {
                    ...event.item,
                    messageId: "host-control",
                    clientMessageId: seq === 0 ? "review-original" : "manual-retry",
                  }
                : event.item,
            ...(event.item.type === "user_message"
              ? { providerMessageId: event.item.messageId }
              : {}),
          },
        ]
      : [],
  );
  const evidence = captureCompletedTurnEvidence(rows, "last")!;
  expect(evidence.origin).toMatchObject({ providerMessageId: "origin" });
  expect(restoreCompletedTurnEvidence(history, evidence)[0]).toMatchObject({
    item: { clientMessageId: "review-original" },
  });
  const replaced = await claudeNativeHistory([
    { ...native[0], uuid: "replacement-origin" },
    ...native.slice(1),
  ]);
  const restored = restoreCompletedTurnEvidence(replaced, evidence);
  expect(restored[0]).not.toMatchObject({ item: { clientMessageId: "review-original" } });
  expect(restored).toEqual(replaced);
  const legacy = {
    ...evidence,
    origin: { digest: evidence.origin!.digest, clientMessageId: "review-original" },
  };
  expect(restoreCompletedTurnEvidence(history, legacy)).toEqual(history);
  expect(
    captureCompletedTurnEvidence(
      rows.map((row) => Object.assign({}, row, { providerMessageId: undefined })),
      "last",
    ),
  ).toBeUndefined();
  const ambiguous = await claudeNativeHistory([
    native[0],
    { ...native[0], uuid: "other-origin" },
    ...native.slice(1),
  ]);
  expect(
    restoreCompletedTurnEvidence(ambiguous, legacy).some(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "review-original",
    ),
  ).toBe(false);
});

test.each(["claude", "codex"] as const)(
  "old serialized evidence without native UUID never authorizes identical replacement history (%s)",
  async (provider) => {
    const directory = await mkdtemp(path.join(tmpdir(), "legacy-completed-evidence-"));
    const logger = createTestLogger();
    const storage = new AgentStorage(directory, logger);
    const client = createTestAgentClient(provider);
    const manager = new AgentManager({
      registry: storage,
      clients: { [provider]: client },
      logger,
    });
    const next = new AgentManager({ registry: storage, clients: { [provider]: client }, logger });
    const agent = await manager.createAgent({ provider, cwd: directory }, undefined, {});
    try {
      await manager.runAgent(agent.id, "Respond with exactly: Same answer", {
        clientMessageId: "workflow:original",
      });
      const turnId = manager.getAgent(agent.id)!.lastCompletedTurnId!;
      expect((await storage.get(agent.id))?.lastCompletedTurnEvidence).toBeUndefined();
      // This is the original serialized round3 shape: host identity and digest, no native UUID.
      const rows = await manager.getTimelineRows(agent.id);
      const evidence = captureCompletedTurnEvidence(
        rows.map((row) =>
          Object.assign(
            {},
            row,
            row.item.type === "user_message" ? { providerMessageId: "old-native-uuid" } : {},
          ),
        ),
        turnId,
      )!;
      delete evidence.prompt.providerMessageId;
      if (evidence.origin) delete evidence.origin.providerMessageId;
      await manager.closeAgent(agent.id);
      await storage.upsert({
        ...(await storage.get(agent.id))!,
        lastCompletedTurnEvidence: evidence,
      });
      const history =
        provider === "claude"
          ? await claudeNativeHistory([
              {
                type: "user",
                uuid: "replacement",
                message: { role: "user", content: "Respond with exactly: Same answer" },
              },
              {
                type: "assistant",
                uuid: "answer",
                message: { role: "assistant", content: "Same answer" },
              },
            ])
          : await codexNativeHistory([
              {
                id: turnId,
                items: [
                  {
                    type: "userMessage",
                    id: "replacement",
                    content: [{ type: "text", text: "Respond with exactly: Same answer" }],
                  },
                  { type: "agentMessage", id: "answer", text: "Same answer" },
                ],
              },
            ]);
      const resume = client.resumeSession.bind(client);
      client.resumeSession = async (...args) => {
        const session = await resume(...args);
        session.streamHistory = async function* () {
          yield* history;
        };
        return session;
      };
      await ensureAgentLoaded(agent.id, {
        agentManager: next,
        agentStorage: new AgentStorage(directory, logger),
        logger,
      });
      for (const force of [false, true]) {
        if (force) await next.hydrateTimelineFromProvider(agent.id, { force });
        const restored = await next.getTimelineRows(agent.id);
        expect(restored[0]?.item).not.toHaveProperty("clientMessageId");
        if (provider === "claude") expect(restored.every((row) => !row.turnId)).toBe(true);
      }
    } finally {
      await manager.closeAgent(agent.id);
      await next.closeAgent(agent.id);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("real Codex restart does not attach a previous client receipt to a replacement provider prompt", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "completed-codex-evidence-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(directory, logger);
  const client = createTestAgentClient("codex");
  let turnId = "",
    providerMessageId = "native-prompt";
  const wrap = (session: AgentSession) => {
    const start = session.startTurn.bind(session);
    session.startTurn = async (prompt, options) => {
      const result = await start(prompt, options);
      turnId = result.turnId;
      (
        session as unknown as { notifySubscribers(event: AgentStreamEvent): void }
      ).notifySubscribers({
        type: "timeline",
        provider: "codex",
        turnId,
        item: {
          type: "user_message",
          text: String(prompt),
          messageId: providerMessageId,
          clientMessageId: options?.clientMessageId,
        },
      });
      return result;
    };
    session.streamHistory = async function* () {
      yield* await codexNativeHistory([
        {
          id: turnId,
          items: [
            {
              type: "userMessage",
              id: providerMessageId,
              content: [{ type: "text", text: "Respond with exactly: Ready JSON" }],
            },
            { type: "agentMessage", id: "answer", text: "Ready JSON" },
          ],
        },
      ]);
    };
    return session;
  };
  const create = client.createSession.bind(client),
    resume = client.resumeSession.bind(client);
  client.createSession = async (...args) => wrap(await create(...args));
  client.resumeSession = async (...args) => wrap(await resume(...args));
  const manager = new AgentManager({ registry: storage, clients: { codex: client }, logger });
  const next = new AgentManager({ registry: storage, clients: { codex: client }, logger });
  const agent = await manager.createAgent({ provider: "codex", cwd: directory }, undefined, {});
  try {
    await manager.runAgent(agent.id, "Respond with exactly: Ready JSON", {
      clientMessageId: "workflow:router:prompt",
    });
    expect((await manager.getTimelineRows(agent.id))[0]?.providerMessageId).toBe("native-prompt");
    await manager.closeAgent(agent.id);
    await ensureAgentLoaded(agent.id, { agentManager: next, agentStorage: storage, logger });
    expect(next.getTimeline(agent.id)[0]).toMatchObject({
      clientMessageId: "workflow:router:prompt",
    });
    providerMessageId = "replacement-prompt";
    await next.hydrateTimelineFromProvider(agent.id, { force: true });
    expect(next.getTimeline(agent.id)[0]).not.toHaveProperty("clientMessageId");
  } finally {
    await manager.closeAgent(agent.id);
    await next.closeAgent(agent.id);
    await rm(directory, { recursive: true, force: true });
  }
});
