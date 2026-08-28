import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { PiRpcAgentClient } from "./agent.js";
import {
  HERDR_ATTACHED_PI_RUNTIME,
  encodeHerdrAttachedPiHandle,
  type HerdrAttachedPiMetadata,
} from "./herdr-attachment.js";
import { HerdrAttachedPiSession } from "./herdr-attached-session.js";
import type { HerdrAgent, HerdrClient } from "./herdr-client.js";
import { FakePi } from "./test-utils/fake-pi.js";

class FakeHerdrClient implements HerdrClient {
  agents: HerdrAgent[] = [];
  prompts: Array<{ target: string; text: string }> = [];
  interrupts: string[] = [];

  async listAgents(): Promise<HerdrAgent[]> {
    return this.agents;
  }

  async getAgent(target: string): Promise<HerdrAgent> {
    const agent = this.agents.find(
      (candidate) =>
        candidate.target === target || candidate.name === target || candidate.paneId === target,
    );
    if (!agent) {
      throw new Error(`missing Herdr target ${target}`);
    }
    return agent;
  }

  async prompt(target: string, text: string): Promise<void> {
    this.prompts.push({ target, text });
  }

  async interrupt(target: string): Promise<void> {
    this.interrupts.push(target);
  }

  async read(): Promise<string> {
    return "";
  }
}

async function writeHistory(file: string, lines: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

async function createAttachment(): Promise<{ file: string; metadata: HerdrAttachedPiMetadata }> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-herdr-attached-session-"));
  const file = path.join(root, "sessions", "native.jsonl");
  const metadata: HerdrAttachedPiMetadata = {
    runtime: HERDR_ATTACHED_PI_RUNTIME,
    herdrSession: "fm-lab-session",
    herdrTarget: "firstmate",
    herdrAlias: "firstmate",
    herdrPaneId: "%7",
    nativeSessionId: "native-pi-session",
    nativeSessionFile: file,
    cwd: path.join(root, "project"),
  };
  await writeHistory(file, [
    {
      type: "session",
      id: metadata.nativeSessionId,
      timestamp: "2026-06-09T00:00:00.000Z",
      cwd: metadata.cwd,
    },
    {
      type: "message",
      id: "user-1",
      timestamp: "2026-06-09T00:00:01.000Z",
      message: { role: "user", content: "existing" },
    },
  ]);
  return { file, metadata };
}

function validHerdrAgent(metadata: HerdrAttachedPiMetadata, file: string): HerdrAgent {
  return {
    target: metadata.herdrTarget,
    name: metadata.herdrAlias,
    kind: "pi",
    status: "idle",
    cwd: metadata.cwd,
    paneId: metadata.herdrPaneId,
    nativeSessionId: metadata.nativeSessionId,
    nativeSessionFile: file,
    lastActivityAt: null,
  };
}

describe("Herdr attached Pi sessions", () => {
  test("lists a live Herdr Pi through Pi import discovery and hides the duplicate native file row", async () => {
    const { file, metadata } = await createAttachment();
    const herdr = new FakeHerdrClient();
    herdr.agents = [
      {
        target: metadata.herdrTarget,
        name: metadata.herdrAlias,
        kind: "pi",
        status: "idle",
        cwd: metadata.cwd,
        paneId: metadata.herdrPaneId,
        nativeSessionId: metadata.nativeSessionId,
        nativeSessionFile: file,
        lastActivityAt: null,
      },
    ];
    const client = new PiRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: new FakePi(),
      herdrClient: herdr,
      providerParams: { sessionDir: path.dirname(file), herdr: { session: metadata.herdrSession } },
    });

    await expect(client.listImportableSessions({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        providerHandleId: encodeHerdrAttachedPiHandle(metadata),
        cwd: metadata.cwd,
        title: "Live Pi: firstmate",
      }),
    ]);
  });

  test("does not probe Herdr during managed Pi imports unless enabled", async () => {
    const { file } = await createAttachment();
    const marker = path.join(path.dirname(path.dirname(file)), "herdr-probed");
    const client = new PiRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: new FakePi(),
      providerParams: {
        sessionDir: path.dirname(file),
        herdr: {
          command: [
            process.execPath,
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "probed")`,
          ],
        },
      },
    });

    await client.listImportableSessions({ limit: 10 });

    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("applies the import limit after sorting Herdr sessions by activity", async () => {
    const older = await createAttachment();
    const newer = await createAttachment();
    older.metadata.herdrTarget = "older";
    older.metadata.herdrAlias = "older";
    newer.metadata.herdrTarget = "newer";
    newer.metadata.herdrAlias = "newer";
    newer.metadata.nativeSessionId = "newer-native-session";
    await writeHistory(older.file, [
      {
        type: "session",
        id: older.metadata.nativeSessionId,
        timestamp: "2026-06-09T00:00:00.000Z",
        cwd: older.metadata.cwd,
      },
    ]);
    await writeHistory(newer.file, [
      {
        type: "session",
        id: newer.metadata.nativeSessionId,
        timestamp: "2026-06-10T00:00:00.000Z",
        cwd: newer.metadata.cwd,
      },
    ]);
    const herdr = new FakeHerdrClient();
    herdr.agents = [
      validHerdrAgent(older.metadata, older.file),
      validHerdrAgent(newer.metadata, newer.file),
    ];
    const sessionDir = await mkdtemp(path.join(tmpdir(), "paseo-empty-pi-sessions-"));
    const client = new PiRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: new FakePi(),
      herdrClient: herdr,
      providerParams: { sessionDir, herdr: { session: "fm-lab-session" } },
    });

    await expect(client.listImportableSessions({ limit: 1 })).resolves.toEqual([
      expect.objectContaining({ title: "Live Pi: newer" }),
    ]);
  });

  test("imports and prompts a Herdr Pi without launching a managed Pi RPC runtime", async () => {
    const { file, metadata } = await createAttachment();
    const pi = new FakePi();
    const herdr = new FakeHerdrClient();
    herdr.agents = [validHerdrAgent(metadata, file)];
    const client = new PiRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: pi,
      herdrClient: herdr,
      providerParams: { herdr: { session: metadata.herdrSession, pollIntervalMs: 60_000 } },
    });
    const imported = await client.importSession(
      { providerHandleId: encodeHerdrAttachedPiHandle(metadata), cwd: metadata.cwd },
      {
        config: { provider: "pi", cwd: metadata.cwd },
        storedConfig: { provider: "pi", cwd: metadata.cwd },
      },
    );

    expect(pi.recordedLaunches).toEqual([]);
    expect(imported.persistence.metadata).toMatchObject({
      runtime: HERDR_ATTACHED_PI_RUNTIME,
      herdrTarget: "firstmate",
      nativeSessionId: "native-pi-session",
      lastSyncedNativeEntryId: "user-1",
    });

    const session = imported.session as HerdrAttachedPiSession;
    const events: AgentStreamEvent[] = [];
    const persistedCursorsDuringEvents: Array<string | undefined> = [];

    await session.startTurn("mobile prompt", { clientMessageId: "client-message-1" });
    expect(herdr.prompts).toEqual([{ target: "firstmate", text: "mobile prompt" }]);

    await writeHistory(file, [
      { type: "session", id: metadata.nativeSessionId, cwd: metadata.cwd },
      { type: "message", id: "user-1", message: { role: "user", content: "existing" } },
      { type: "message", id: "user-2", message: { role: "user", content: "mobile prompt" } },
      {
        type: "message",
        id: "assistant-1",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
      },
    ]);

    session.subscribe((event) => {
      events.push(event);
      persistedCursorsDuringEvents.push(
        session.describePersistence(event)?.metadata?.lastSyncedNativeEntryId as string | undefined,
      );
    });
    await session.reconcileHistory();
    expect(session.describePersistence()?.metadata).toMatchObject({
      lastSyncedNativeEntryId: "assistant-1",
    });
    expect(persistedCursorsDuringEvents).toEqual(["user-2", "assistant-1", "assistant-1"]);
    await session.close();

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "pi",
        turnId: expect.any(String),
        item: {
          type: "user_message",
          text: "mobile prompt",
          messageId: "user-2",
          clientMessageId: "client-message-1",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "assistant_message", text: "answer", messageId: "assistant-1" },
      },
      { type: "turn_completed", provider: "pi", turnId: expect.any(String) },
    ]);
  });

  test("resumes persisted Herdr metadata without launching a managed Pi runtime", async () => {
    const { file, metadata } = await createAttachment();
    const pi = new FakePi();
    const herdr = new FakeHerdrClient();
    herdr.agents = [validHerdrAgent(metadata, file)];
    const client = new PiRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: pi,
      herdrClient: herdr,
      providerParams: { herdr: { session: metadata.herdrSession, pollIntervalMs: 60_000 } },
    });

    const session = await client.resumeSession({
      provider: "pi",
      sessionId: encodeHerdrAttachedPiHandle(metadata),
      nativeHandle: file,
      metadata,
    });
    await session.startTurn("after restart");
    await session.close();

    expect(session).toBeInstanceOf(HerdrAttachedPiSession);
    expect(pi.recordedLaunches).toEqual([]);
    expect(herdr.prompts).toEqual([{ target: "firstmate", text: "after restart" }]);
  });

  test("rejects malformed attached metadata without launching managed Pi", async () => {
    const pi = new FakePi();
    const client = new PiRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: pi,
    });

    await expect(
      client.resumeSession({
        provider: "pi",
        sessionId: "corrupt-attached-session",
        nativeHandle: "/tmp/native.jsonl",
        metadata: { runtime: HERDR_ATTACHED_PI_RUNTIME },
      }),
    ).rejects.toThrow("Invalid Herdr-attached Pi persistence metadata");
    expect(pi.recordedLaunches).toEqual([]);
  });

  test("recovers from a transient reconciliation failure", async () => {
    const { file, metadata } = await createAttachment();
    const herdr = new FakeHerdrClient();
    const session = new HerdrAttachedPiSession({
      herdrClient: herdr,
      metadata,
      config: { cwd: metadata.cwd },
      pollIntervalMs: 60_000,
    });

    await session.reconcileHistory();
    herdr.agents = [validHerdrAgent(metadata, file)];
    await expect(session.startTurn("recovered prompt")).resolves.toEqual({
      turnId: expect.any(String),
    });
    await session.close();

    expect(herdr.prompts).toEqual([{ target: "firstmate", text: "recovered prompt" }]);
  });

  test("preserves an active turn across a transient polling failure", async () => {
    const { file, metadata } = await createAttachment();
    const herdr = new FakeHerdrClient();
    herdr.agents = [validHerdrAgent(metadata, file)];
    const session = new HerdrAttachedPiSession({
      herdrClient: herdr,
      metadata,
      config: { cwd: metadata.cwd },
      pollIntervalMs: 60_000,
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("still running");
    herdr.agents = [];
    await session.reconcileHistory();

    expect(events).toEqual([]);
    await expect(session.startTurn("duplicate")).rejects.toThrow(
      "A Herdr-attached Pi turn is already active",
    );
    await session.close();
  });

  test("does not complete a submitted turn from backlogged native entries", async () => {
    const { file, metadata } = await createAttachment();
    metadata.lastSyncedNativeEntryId = "user-1";
    await writeHistory(file, [
      { type: "session", id: metadata.nativeSessionId, cwd: metadata.cwd },
      { type: "message", id: "user-1", message: { role: "user", content: "existing" } },
      {
        type: "message",
        id: "assistant-backlog",
        message: { role: "assistant", content: [] },
      },
    ]);
    const herdr = new FakeHerdrClient();
    herdr.agents = [validHerdrAgent(metadata, file)];
    const session = new HerdrAttachedPiSession({
      herdrClient: herdr,
      metadata,
      config: { cwd: metadata.cwd },
      pollIntervalMs: 60_000,
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("new prompt", { clientMessageId: "new-client-message" });
    await session.reconcileHistory();

    expect(events).not.toContainEqual(expect.objectContaining({ type: "turn_completed" }));
    await expect(session.startTurn("duplicate")).rejects.toThrow(
      "A Herdr-attached Pi turn is already active",
    );
    await writeHistory(file, [
      { type: "session", id: metadata.nativeSessionId, cwd: metadata.cwd },
      { type: "message", id: "user-1", message: { role: "user", content: "existing" } },
      {
        type: "message",
        id: "assistant-backlog",
        message: { role: "assistant", content: [] },
      },
      { type: "message", id: "user-2", message: { role: "user", content: "new prompt" } },
      {
        type: "message",
        id: "assistant-2",
        message: { role: "assistant", content: [] },
      },
    ]);
    await session.reconcileHistory();

    expect(events).toContainEqual(expect.objectContaining({ type: "turn_completed" }));
    await session.close();
  });

  test("commits a native entry cursor only after its final mapped event", async () => {
    const { file, metadata } = await createAttachment();
    metadata.lastSyncedNativeEntryId = "user-1";
    await writeHistory(file, [
      { type: "session", id: metadata.nativeSessionId, cwd: metadata.cwd },
      { type: "message", id: "user-1", message: { role: "user", content: "existing" } },
      {
        type: "message",
        id: "assistant-1",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "considering" },
            { type: "text", text: "answer" },
          ],
        },
      },
    ]);
    const herdr = new FakeHerdrClient();
    herdr.agents = [validHerdrAgent(metadata, file)];
    const session = new HerdrAttachedPiSession({
      herdrClient: herdr,
      metadata,
      config: { cwd: metadata.cwd },
      pollIntervalMs: 60_000,
    });
    const cursors: Array<string | undefined> = [];
    session.subscribe((event) => {
      cursors.push(
        session.describePersistence(event)?.metadata?.lastSyncedNativeEntryId as string | undefined,
      );
    });

    await session.reconcileHistory();
    await session.close();

    expect(cursors).toEqual(["user-1", "assistant-1"]);
  });

  test("rejects a persisted attachment from another Herdr session", async () => {
    const { file, metadata } = await createAttachment();
    const pi = new FakePi();
    const client = new PiRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: pi,
      herdrClient: new FakeHerdrClient(),
      providerParams: { herdr: { session: "different-session" } },
    });

    await expect(
      client.resumeSession({
        provider: "pi",
        sessionId: encodeHerdrAttachedPiHandle(metadata),
        nativeHandle: file,
        metadata,
      }),
    ).rejects.toThrow("belongs to fm-lab-session, not different-session");
    expect(pi.recordedLaunches).toEqual([]);
  });

  test("refuses prompt injection when the Herdr target points at a different Pi session", async () => {
    const { file, metadata } = await createAttachment();
    const herdr = new FakeHerdrClient();
    herdr.agents = [{ ...validHerdrAgent(metadata, file), nativeSessionId: "replacement-session" }];
    const session = new HerdrAttachedPiSession({
      herdrClient: herdr,
      metadata,
      config: { cwd: metadata.cwd },
      pollIntervalMs: 60_000,
    });

    await expect(session.startTurn("unsafe prompt")).rejects.toThrow(
      "Native Pi session changed for Herdr target firstmate",
    );
    await session.close();

    expect(herdr.prompts).toEqual([]);
  });

  test("refuses prompt injection while the original Pi is already running", async () => {
    const { file, metadata } = await createAttachment();
    const herdr = new FakeHerdrClient();
    herdr.agents = [{ ...validHerdrAgent(metadata, file), status: "working" }];
    const session = new HerdrAttachedPiSession({
      herdrClient: herdr,
      metadata,
      config: { cwd: metadata.cwd },
      pollIntervalMs: 60_000,
    });

    await expect(session.startTurn("too soon")).rejects.toThrow(
      "Herdr target firstmate is already running",
    );
    await session.close();

    expect(herdr.prompts).toEqual([]);
  });

  test("interrupts the original Herdr target instead of a managed Pi runtime", async () => {
    const { file, metadata } = await createAttachment();
    const herdr = new FakeHerdrClient();
    herdr.agents = [validHerdrAgent(metadata, file)];
    const session = new HerdrAttachedPiSession({
      herdrClient: herdr,
      metadata,
      config: { cwd: metadata.cwd },
      pollIntervalMs: 60_000,
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("cancel me");
    await session.interrupt();
    await session.close();

    expect(herdr.interrupts).toEqual(["firstmate"]);
    expect(events).toEqual([
      { type: "turn_canceled", provider: "pi", reason: "interrupted", turnId: expect.any(String) },
    ]);
  });
});
