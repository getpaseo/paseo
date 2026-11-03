import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type {
  AgentPersistenceHandle,
  AgentSession,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../../agent-sdk-types.js";
import { AgentManager, type AgentManagerEvent } from "../../agent-manager.js";
import { OmpAgentClient } from "./agent.js";
import { parseOmpMountNotice } from "./mount-notice.js";
import type { OmpRuntimeEvent } from "./rpc-types.js";
import { FakeOmp } from "./test-utils/fake-omp.js";

const AGENT_ID = "8b0c7a52-6f4e-4c4b-9f55-6a5f0f2f6b11";
const BROWSER_AND_LINEAR = "xd://: mounted browser, mcp__linear__search";

type NoticeLevel = "info" | "warning" | "error";

function notice(
  message: string,
  options: { level?: NoticeLevel; source?: string | null } = {},
): OmpRuntimeEvent {
  const source = options.source === undefined ? "xdev" : options.source;
  return {
    type: "notice",
    level: options.level ?? "info",
    message,
    ...(source === null ? {} : { source }),
  };
}

function notifications(items: readonly AgentTimelineItem[]): string[] {
  return items.flatMap((item) => (item.type === "notification" ? [item.message] : []));
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function writeSessionFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-omp-mount-notice-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const sessionFile = join(directory, "session.jsonl");
  const entries = [
    { type: "session", id: "root", parentId: null },
    { type: "message", id: "u1", parentId: "root", message: { role: "user", content: "hi" } },
  ];
  await writeFile(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
  return sessionFile;
}

function persistenceHandle(sessionFile: string): AgentPersistenceHandle {
  return {
    provider: "omp",
    sessionId: "omp-session",
    nativeHandle: sessionFile,
    metadata: { cwd: process.cwd() },
  };
}

async function drain(history: AsyncGenerator<AgentStreamEvent>): Promise<void> {
  for await (const _event of history) {
    // Consumed the way the manager seeds a projection.
  }
}

async function closeQuietly(manager: AgentManager, agentId: string): Promise<void> {
  await manager.closeAgent(agentId).catch(() => undefined);
}

/** One Paseo agent whose OMP process the daemon relaunches, as idle collection and reload do. */
class MountNoticeHarness {
  readonly omp = new FakeOmp();
  readonly client = new OmpAgentClient({ logger: createTestLogger(), runtime: this.omp });
  private readonly events: AgentStreamEvent[] = [];
  private session: AgentSession | null = null;

  constructor(private readonly sessionFile: string) {}

  handle(): AgentPersistenceHandle {
    return persistenceHandle(this.sessionFile);
  }

  async relaunch(): Promise<void> {
    await this.session?.close();
    const session = await this.client.resumeSession(this.handle(), undefined, {
      agentId: AGENT_ID,
    });
    this.session = session;
    session.subscribe((event) => this.events.push(event));
    cleanups.push(() => session.close());
  }

  async announce(event: OmpRuntimeEvent | string): Promise<void> {
    this.omp.latestSession().emit(typeof event === "string" ? notice(event) : event);
    await waitForImmediate();
  }

  /** The current session seeds a fresh projection from provider history. */
  async seedFromHistory(): Promise<void> {
    if (!this.session) throw new Error("No OMP session");
    await drain(this.session.streamHistory());
  }

  async readArchivedHistory(agentId = AGENT_ID): Promise<void> {
    const history = await this.client.resumeSession(
      this.handle(),
      undefined,
      { agentId },
      {
        purpose: "history",
      },
    );
    await drain(history.streamHistory());
    await history.close();
  }

  notifications(): string[] {
    return notifications(
      this.events.flatMap((event) => (event.type === "timeline" ? [event.item] : [])),
    );
  }
}

async function harness(): Promise<MountNoticeHarness> {
  const omp = new MountNoticeHarness(await writeSessionFile());
  await omp.relaunch();
  return omp;
}

describe("parseOmpMountNotice", () => {
  test("reads mounted and unmounted devices", () => {
    expect(parseOmpMountNotice(notice("xd://: mounted a, b; unmounted c"))).toEqual({
      mounted: ["a", "b"],
      unmounted: ["c"],
    });
  });

  test("accepts OMP builds that omit the notice source", () => {
    expect(parseOmpMountNotice(notice("xd://: unmounted a", { source: null }))).toEqual({
      mounted: [],
      unmounted: ["a"],
    });
  });

  test("leaves other notices alone", () => {
    expect(parseOmpMountNotice(notice(BROWSER_AND_LINEAR, { source: "btw" }))).toBeNull();
    expect(parseOmpMountNotice(notice(BROWSER_AND_LINEAR, { level: "warning" }))).toBeNull();
    expect(parseOmpMountNotice(notice(BROWSER_AND_LINEAR, { level: "error" }))).toBeNull();
    expect(parseOmpMountNotice(notice("xd://: rescanned devices"))).toBeNull();
    expect(parseOmpMountNotice(notice("xd://: mounted a, "))).toBeNull();
    expect(parseOmpMountNotice(notice("Session saved"))).toBeNull();
  });
});

describe("OMP xd:// mount notices", () => {
  test("retaining announced mounts does not retain closed OMP sessions", () => {
    const fixture = fileURLToPath(new URL("./test-utils/mount-notice-memory.ts", import.meta.url));
    const output = execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", fixture], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(JSON.parse(output)).toEqual({
      closedWithoutNoticeRetained: false,
      closedWithNoticeRetained: false,
      noticesAfterRelaunch: 1,
    });
  });

  test("a relaunched OMP process does not repeat a mount set the timeline already shows", async () => {
    const omp = await harness();
    await omp.announce(BROWSER_AND_LINEAR);

    await omp.relaunch();
    await omp.announce(BROWSER_AND_LINEAR);
    await omp.relaunch();
    await omp.announce("xd://: mounted mcp__linear__search");
    await omp.announce("xd://: mounted browser");

    expect(omp.notifications()).toEqual([BROWSER_AND_LINEAR]);
  });

  test("a changed mount set is shown as OMP reported it", async () => {
    const omp = await harness();
    await omp.announce(BROWSER_AND_LINEAR);

    await omp.relaunch();
    const withGithub = "xd://: mounted browser, mcp__linear__search, mcp__github__search";
    await omp.announce(withGithub);
    await omp.announce("xd://: unmounted browser");
    await omp.relaunch();
    await omp.announce("xd://: unmounted browser");

    expect(omp.notifications()).toEqual([
      BROWSER_AND_LINEAR,
      withGithub,
      "xd://: unmounted browser",
    ]);
  });

  test("a device mounted again after an unmount is shown", async () => {
    const omp = await harness();
    await omp.announce(BROWSER_AND_LINEAR);
    await omp.announce("xd://: unmounted browser");
    await omp.announce("xd://: mounted browser");

    expect(omp.notifications()).toEqual([
      BROWSER_AND_LINEAR,
      "xd://: unmounted browser",
      "xd://: mounted browser",
    ]);
  });

  test("identical ordinary notices are all shown", async () => {
    const omp = await harness();
    await omp.announce(notice("Session saved", { source: "session-persistence" }));
    await omp.relaunch();
    await omp.announce(notice("Session saved", { source: "session-persistence" }));
    await omp.announce(notice(BROWSER_AND_LINEAR, { source: "btw-history" }));
    await omp.announce(notice(BROWSER_AND_LINEAR, { source: "btw-history" }));

    expect(omp.notifications()).toEqual([
      "Session saved",
      "Session saved",
      BROWSER_AND_LINEAR,
      BROWSER_AND_LINEAR,
    ]);
  });

  test("identical xd:// warnings and errors are all shown", async () => {
    const omp = await harness();
    await omp.announce(BROWSER_AND_LINEAR);
    for (const level of ["warning", "error"] as const) {
      await omp.announce(notice(BROWSER_AND_LINEAR, { level }));
      await omp.relaunch();
      await omp.announce(notice(BROWSER_AND_LINEAR, { level }));
    }

    expect(omp.notifications()).toEqual([
      BROWSER_AND_LINEAR,
      BROWSER_AND_LINEAR,
      BROWSER_AND_LINEAR,
      BROWSER_AND_LINEAR,
      BROWSER_AND_LINEAR,
    ]);
  });

  test("a projection seeded from history drops mounts earlier sessions showed", async () => {
    const omp = await harness();
    await omp.announce(BROWSER_AND_LINEAR);

    await omp.relaunch();
    await omp.seedFromHistory();
    await omp.announce(BROWSER_AND_LINEAR);

    expect(omp.notifications()).toEqual([BROWSER_AND_LINEAR, BROWSER_AND_LINEAR]);
  });

  test("a projection seeded from history keeps mounts its own session already showed", async () => {
    const omp = await harness();
    await omp.announce(BROWSER_AND_LINEAR);
    await omp.seedFromHistory();

    await omp.relaunch();
    await omp.announce(BROWSER_AND_LINEAR);

    expect(omp.notifications()).toEqual([BROWSER_AND_LINEAR]);
  });

  test("reading the agent's archived history drops the mounts it no longer shows", async () => {
    const omp = await harness();
    await omp.announce(BROWSER_AND_LINEAR);

    await omp.readArchivedHistory();
    await omp.relaunch();
    await omp.announce(BROWSER_AND_LINEAR);

    expect(omp.notifications()).toEqual([BROWSER_AND_LINEAR, BROWSER_AND_LINEAR]);
  });

  test("reading another agent's history of the same session file keeps this agent's mounts", async () => {
    const omp = await harness();
    await omp.announce(BROWSER_AND_LINEAR);

    await omp.readArchivedHistory("2d1e4f7a-0c3b-4d8e-a9f6-5b7c8d9e0f12");
    await omp.relaunch();
    await omp.announce(BROWSER_AND_LINEAR);

    expect(omp.notifications()).toEqual([BROWSER_AND_LINEAR]);
  });

  test("a notice nobody received does not hide the next one", async () => {
    const omp = new MountNoticeHarness(await writeSessionFile());
    const unobserved = await omp.client.resumeSession(omp.handle(), undefined, {
      agentId: AGENT_ID,
    });
    cleanups.push(() => unobserved.close());
    await omp.announce(BROWSER_AND_LINEAR);
    await unobserved.close();

    await omp.relaunch();
    await omp.announce(BROWSER_AND_LINEAR);

    expect(omp.notifications()).toEqual([BROWSER_AND_LINEAR]);
  });

  test("an approval mode change keeps the mount set the timeline already shows", async () => {
    const omp = new FakeOmp();
    const client = new OmpAgentClient({ logger: createTestLogger(), runtime: omp });
    const session = await client.createSession({ provider: "omp", cwd: process.cwd() });
    cleanups.push(() => session.close());
    const items: AgentTimelineItem[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline") items.push(event.item);
    });
    omp.latestSession().emit(notice(BROWSER_AND_LINEAR));
    await waitForImmediate();

    await session.setMode("ask");
    omp.latestSession().emit(notice(BROWSER_AND_LINEAR));
    await waitForImmediate();

    expect(omp.recordedLaunches).toHaveLength(2);
    expect(notifications(items)).toEqual([BROWSER_AND_LINEAR]);
  });
});

/** A daemon AgentManager driving one OMP agent through FakeOmp. */
class DaemonTimelineHarness {
  readonly omp = new FakeOmp();
  readonly manager = new AgentManager({
    clients: {
      omp: new OmpAgentClient({
        logger: createTestLogger(),
        runtime: this.omp,
        // FakeOmp supplies the runtime; the manager still checks command availability.
        runtimeSettings: { command: { mode: "replace", argv: [process.execPath] } },
      }),
    },
    logger: createTestLogger(),
  });
  readonly live: Array<{
    epoch: string | undefined;
    seq: number | undefined;
    item: AgentTimelineItem;
  }> = [];

  constructor(readonly agentId: string) {
    cleanups.push(() => closeQuietly(this.manager, agentId));
    this.manager.subscribe(
      (event: AgentManagerEvent) => {
        if (event.type === "agent_stream" && event.event.type === "timeline") {
          this.live.push({ epoch: event.epoch, seq: event.seq, item: event.event.item });
        }
      },
      { agentId, replayState: false },
    );
  }

  /** What the agent loader does when a chat opens an agent the daemon has not loaded. */
  async load(handle: AgentPersistenceHandle): Promise<void> {
    await this.manager.resumeAgentFromPersistence(handle, undefined, this.agentId);
    await this.manager.hydrateTimelineFromProvider(this.agentId);
  }

  async announce(event: OmpRuntimeEvent | string): Promise<void> {
    this.omp.latestSession().emit(typeof event === "string" ? notice(event) : event);
    await waitForImmediate();
  }

  async prompt(text: string): Promise<void> {
    await this.manager.appendTimelineItem(this.agentId, { type: "user_message", text });
  }

  fetchAll() {
    return this.manager.fetchTimeline(this.agentId, { direction: "tail", limit: 0 });
  }

  fetchedNotifications(): string[] {
    return notifications(this.fetchAll().rows.map((row) => row.item));
  }
}

describe("OMP mount notices in the daemon timeline", () => {
  test("a mount staged near rewind completion is announced on the next runtime", async () => {
    const daemon = new DaemonTimelineHarness(AGENT_ID);
    const handle = persistenceHandle(await writeSessionFile());
    await daemon.load(handle);
    const user = daemon.fetchAll().rows.find((row) => row.item.type === "user_message")?.item;
    if (user?.type !== "user_message" || !user.messageId) throw new Error("No rewind target");
    const runtime = daemon.omp.latestSession();
    const before = runtime.getStateRequestCount;
    let release = runtime.holdStateRequests();
    const rewind = daemon.manager.rewind(AGENT_ID, user.messageId, "conversation");
    try {
      await runtime.waitForStateRequests(before + 1);
      release();
      release = runtime.holdStateRequests();
      await runtime.waitForStateRequests(before + 2);
      await daemon.announce(BROWSER_AND_LINEAR);
    } finally {
      release();
      await rewind;
    }
    expect(daemon.fetchedNotifications()).toEqual([]);
    await daemon.manager.closeAgent(AGENT_ID);
    await daemon.load(handle);
    await daemon.announce(BROWSER_AND_LINEAR);
    expect(daemon.fetchedNotifications()).toEqual([BROWSER_AND_LINEAR]);
  });

  test("live delivery and fetched history agree after idle collection relaunches OMP", async () => {
    const daemon = new DaemonTimelineHarness(AGENT_ID);
    await daemon.load(persistenceHandle(await writeSessionFile()));
    await daemon.announce(BROWSER_AND_LINEAR);
    await daemon.prompt("first prompt");
    const handle = daemon.manager.getAgent(AGENT_ID)?.persistence;
    if (!handle) throw new Error("OMP agent has no persistence handle");
    const epoch = daemon.fetchAll().epoch;
    const historyRows = daemon.fetchAll().rows.length - 2;

    await daemon.manager.closeAgent(AGENT_ID);
    await daemon.load(handle);
    await daemon.announce(BROWSER_AND_LINEAR);
    await daemon.announce(notice("Session saved", { source: null }));
    await daemon.prompt("second prompt");
    await daemon.manager.flush();

    const fetched = daemon.fetchAll();
    expect(daemon.omp.recordedLaunches.at(-1)?.session).toBe(handle.nativeHandle);
    expect(fetched.epoch).toBe(epoch);
    expect(fetched.rows.slice(historyRows).map((row) => row.item)).toEqual([
      { type: "notification", level: "info", message: BROWSER_AND_LINEAR },
      expect.objectContaining({ type: "user_message", text: "first prompt" }),
      { type: "notification", level: "info", message: "Session saved" },
      expect.objectContaining({ type: "user_message", text: "second prompt" }),
    ]);
    const liveRows = daemon.live.filter((entry) => entry.epoch === epoch);
    expect(liveRows.map((entry) => entry.item)).toEqual(
      fetched.rows.slice(historyRows).map((row) => row.item),
    );
    expect(liveRows.map((entry) => entry.seq)).toEqual(
      fetched.rows.slice(historyRows).map((row) => row.seqEnd),
    );
    const seqs = fetched.rows.map((row) => row.seqEnd);
    expect(seqs).toEqual(seqs.map((_seq, index) => index + 1));
    expect(fetched.hasOlder).toBe(false);
    expect(fetched.hasNewer).toBe(false);

    const afterFirstPrompt = daemon.manager.fetchTimeline(AGENT_ID, {
      direction: "after",
      cursor: { epoch, seq: historyRows + 2 },
      limit: 0,
    });
    expect(afterFirstPrompt.gap).toBe(false);
    expect(afterFirstPrompt.rows.map((row) => row.item)).toEqual(
      fetched.rows.slice(historyRows + 2).map((row) => row.item),
    );
  });

  test("a mount notice that lands before history seeding still suppresses the next relaunch", async () => {
    const daemon = new DaemonTimelineHarness(AGENT_ID);
    const handle = persistenceHandle(await writeSessionFile());
    await daemon.manager.resumeAgentFromPersistence(handle, undefined, AGENT_ID);
    await daemon.announce(BROWSER_AND_LINEAR);
    await daemon.manager.hydrateTimelineFromProvider(AGENT_ID);

    await daemon.manager.closeAgent(AGENT_ID);
    await daemon.load(handle);
    await daemon.announce(BROWSER_AND_LINEAR);

    expect(daemon.fetchedNotifications()).toEqual([BROWSER_AND_LINEAR]);
  });

  test("a conversation rewind starts a projection that shows the mount set once", async () => {
    const daemon = new DaemonTimelineHarness(AGENT_ID);
    const handle = persistenceHandle(await writeSessionFile());
    await daemon.load(handle);
    await daemon.announce(BROWSER_AND_LINEAR);
    const userMessage = daemon
      .fetchAll()
      .rows.map((row) => row.item)
      .find((item) => item.type === "user_message");
    if (userMessage?.type !== "user_message" || !userMessage.messageId) {
      throw new Error("History has no user message to rewind to");
    }

    await daemon.manager.rewind(AGENT_ID, userMessage.messageId, "conversation");
    expect(daemon.fetchedNotifications()).toEqual([]);
    await daemon.manager.closeAgent(AGENT_ID);
    await daemon.load(handle);
    await daemon.announce(BROWSER_AND_LINEAR);

    expect(daemon.fetchedNotifications()).toEqual([BROWSER_AND_LINEAR]);
  });

  test("reloading from disk starts a projection that shows the mount set once", async () => {
    const daemon = new DaemonTimelineHarness(AGENT_ID);
    await daemon.load(persistenceHandle(await writeSessionFile()));
    await daemon.announce(BROWSER_AND_LINEAR);
    const epoch = daemon.fetchAll().epoch;

    await daemon.manager.reloadAgentSession(AGENT_ID, undefined, { rehydrateFromDisk: true });
    await daemon.manager.hydrateTimelineFromProvider(AGENT_ID);
    await daemon.announce(BROWSER_AND_LINEAR);
    await daemon.manager.reloadAgentSession(AGENT_ID);
    await daemon.announce(BROWSER_AND_LINEAR);

    expect(daemon.fetchAll().epoch).not.toBe(epoch);
    expect(daemon.fetchedNotifications()).toEqual([BROWSER_AND_LINEAR]);
  });
});
