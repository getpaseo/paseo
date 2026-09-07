import {
  createInitDeferred,
  getInitDeferred,
  getInitKey,
  resolveInitDeferred,
} from "@/utils/agent-initialization";
import mixedMessage from "./__fixtures__/mixed-unpositioned-message.json";
import legacyTimeline from "./__fixtures__/legacy-unverifiable-timeline.json";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplicaCache, type CachedTimeline } from "@/runtime/replica-cache";
import type {
  ReplicaHostRows,
  ReplicaRow,
  ReplicaRowChanges,
  ReplicaRowStore,
} from "@/runtime/replica-cache/row-store";
import { loadOlderAgentHistory } from "@/hooks/use-load-older-agent-history";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import { createUserMessage, type StreamItem } from "@/types/stream";
import {
  createTimelineReplica,
  type TimelineResponsePayload,
  type TimelineReplicaStorage,
} from "./replica";
import { createViewedTimelineOwner } from "./viewed-timeline-sync";

const host = "transaction-host";
const otherHost = "transaction-other";
const agentId = "agent";
const timestamp = "2026-09-06T10:00:00.000Z";

class MemoryRows implements ReplicaRowStore {
  rows = new Map<string, ReplicaRow>();
  async open() {}
  async read(
    serverIds: readonly string[],
    kinds: readonly ReplicaRow["kind"][],
    ids?: readonly string[],
  ): Promise<ReplicaRow[]> {
    return [...this.rows.values()].filter(
      (row) =>
        serverIds.includes(row.serverId) &&
        kinds.includes(row.kind) &&
        (!ids || ids.includes(row.id)),
    );
  }

  async readAll(): Promise<ReplicaHostRows[]> {
    return [host, otherHost].map((serverId) => ({
      serverId,
      rows: [...this.rows.values()].filter((row) => row.serverId === serverId),
    }));
  }
  async apply(changes: ReplicaRowChanges) {
    for (const row of changes.deletes) this.rows.delete(`${row.serverId}:${row.kind}:${row.id}`);
    for (const row of changes.upserts) this.rows.set(`${row.serverId}:${row.kind}:${row.id}`, row);
  }
  async deleteHost(serverId: string) {
    for (const [key, row] of this.rows) if (row.serverId === serverId) this.rows.delete(key);
  }
  async renameHost(oldId: string, newId: string) {
    const rows = [...this.rows.values()].filter((row) => row.serverId === oldId);
    await this.deleteHost(oldId);
    await this.apply({
      deletes: [],
      upserts: rows.map((row) => ({
        kind: row.kind,
        id: row.id,
        payload: row.payload,
        serverId: newId,
      })),
    });
  }
  async clear() {
    this.rows.clear();
  }
}

function cache(rows: MemoryRows): ReplicaCache {
  const result = new ReplicaCache(rows, { clearLegacyCache: async () => undefined });
  result.setHosts([host, otherHost]);
  return result;
}

function saved(): CachedTimeline {
  return {
    agentId,
    hasOlder: false,
    range: { epoch: "epoch-1", startSeq: 1, endSeq: 80 },
    items: Array.from(
      { length: 80 },
      (_, i): StreamItem => ({
        kind: "assistant_message",
        id: `message-${i + 1}`,
        messageId: `message-${i + 1}`,
        text: `row ${i + 1}`,
        timestamp: new Date(timestamp),
        timelineCursor: { epoch: "epoch-1", seq: i + 1 },
        source: { startSeq: i + 1, chunks: [{ seq: i + 1, offset: 0 }] },
      }),
    ),
  };
}

function page(
  start: number,
  end: number,
  hasNewer = false,
  epoch = "epoch-1",
): TimelineResponsePayload {
  return {
    requestId: `page-${epoch}-${end}`,
    agentId,
    agent: null,
    direction: "after",
    projection: "projected",
    reset: false,
    epoch,
    staleCursor: false,
    gap: false,
    window: { minSeq: 1, maxSeq: end, nextSeq: end + 1 },
    startCursor: { epoch, seq: start },
    endCursor: { epoch, seq: end },
    hasOlder: true,
    hasNewer,
    error: null,
    entries: Array.from({ length: end - start + 1 }, (_, i) => ({
      provider: "claude" as const,
      item: {
        type: "assistant_message" as const,
        text: `row ${start + i}`,
        messageId: `message-${start + i}`,
      },
      timestamp,
      seqStart: start + i,
      seqEnd: start + i,
      sourceSeqRanges: [{ startSeq: start + i, endSeq: start + i }],
      collapsed: [],
    })),
  };
}

function owner(storage: TimelineReplicaStorage, serverId = host) {
  const replica = createTimelineReplica({ serverId, storage });
  const viewed = createViewedTimelineOwner({
    serverId,
    replica,
    replaceDemandedAgentIds: () => undefined,
    drainQueuedAgentMessage: () => undefined,
    ports: {
      initialDeliveryMode: "legacy",
      setSubscription: async () => undefined,
      fetchPage: async () => ({ hasNewer: false, endCursor: null }),
      fetchLatestTail: async () => ({ hasNewer: false, endCursor: null }),
      reportError: (error) => {
        throw error;
      },
      schedule: () => () => undefined,
    },
  });
  return { replica, viewed };
}

function live(viewed: ReturnType<typeof owner>["viewed"], seq: number) {
  viewed.enqueueStreamEvent(agentId, {
    seq,
    epoch: "epoch-1",
    timestamp: new Date(timestamp),
    event: {
      type: "timeline",
      provider: "claude",
      item: { type: "assistant_message", text: `row ${seq}`, messageId: `message-${seq}` },
    },
  });
}

afterEach(() => {
  useSessionStore.getState().clearSession(host);
  useSessionStore.getState().clearSession(otherHost);
});

describe("timeline transaction restart contract", () => {
  it.each([false, true])(
    "reconciles recorded markdown through display-only reopen (newer live=%s)",
    async (newer) => {
      useSessionStore.getState().initializeSession(host, null);
      const rows = new MemoryRows();
      const disk = cache(rows);
      const { replica, viewed } = owner(disk);
      await replica.prepare(agentId);
      viewed.beginTimelineRequest(agentId, true)({ ...page(10219, 10219), direction: "tail" });
      for (const text of [...mixedMessage.chunks, ...(newer ? ["Newer text"] : [])]) {
        viewed.enqueueStreamEvent(agentId, {
          timestamp: new Date(timestamp),
          seq: undefined,
          epoch: undefined,
          event: {
            type: "timeline",
            provider: "codex",
            item: {
              type: "assistant_message",
              messageId: mixedMessage.entry.item.messageId,
              text,
            },
          },
        });
        viewed.flushStreamAgent(agentId);
      }
      const displayed = () => {
        const session = useSessionStore.getState().sessions[host]!;
        return [
          ...(session.agentStreamTail.get(agentId) ?? []),
          ...(session.agentStreamHead.get(agentId) ?? []),
        ];
      };
      const messageRows = (items: StreamItem[]) =>
        items.filter(
          (row) =>
            row.kind === "assistant_message" && row.messageId === mixedMessage.entry.item.messageId,
        );
      expect(messageRows(displayed())).toHaveLength(2);
      const expectedTexts = newer
        ? messageRows(displayed()).map((row) => ("text" in row ? row.text : ""))
        : [mixedMessage.entry.item.text];
      if (newer) expect(expectedTexts.join("\n\n")).toContain("session.\nNewer text");
      const tool = {
        type: "tool_call" as const,
        name: "shell",
        callId: "following-tool",
        status: "running" as const,
        error: null,
        detail: { type: "shell" as const, command: "pwd" },
      };
      // The real tool follows the split message; positions resume on this connection.
      viewed.enqueueStreamEvent(agentId, {
        seq: undefined,
        epoch: undefined,
        timestamp: new Date(timestamp),
        event: { type: "timeline", provider: "codex", item: tool },
      });
      viewed.flushStreamAgent(agentId);
      viewed.applyTimelineResponse({
        ...page(10220, 10262),
        entries: [
          {
            ...mixedMessage.entry,
            provider: "codex",
            item: { ...mixedMessage.entry.item, type: "assistant_message" },
            collapsed: ["assistant_merge"],
          },
          {
            provider: "codex",
            item: tool,
            timestamp,
            seqStart: 10244,
            seqEnd: 10262,
            sourceSeqRanges: [
              { startSeq: 10244, endSeq: 10244 },
              { startSeq: 10262, endSeq: 10262 },
            ],
            collapsed: ["tool_lifecycle"],
          },
        ],
      });
      expect(messageRows(displayed()).map((row) => ("text" in row ? row.text : ""))).toEqual(
        expectedTexts,
      );
      expect(
        displayed()
          .slice(-2)
          .map((row) => row.kind),
      ).toEqual(["assistant_message", "tool_call"]);
      await disk.flush();
      const certified = await cache(rows).readTimeline(host, agentId);
      expect(messageRows(certified!.items)).toHaveLength(1);
      expect(certified?.range).toEqual({ epoch: "epoch-1", startSeq: 10219, endSeq: 10262 });
      expect(replica.readCursor(agentId)).toEqual({ epoch: "epoch-1", endSeq: 10262 });
      viewed.enqueueStreamEvent(agentId, {
        seq: undefined,
        epoch: undefined,
        timestamp: new Date(timestamp),
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", messageId: "later", text: "later update" },
        },
      });
      viewed.flushStreamAgent(agentId);
      await disk.flush();
      const reopened = await cache(rows).readTimeline(host, agentId);
      expect(reopened?.range).toBeNull();
      expect(messageRows(reopened!.items).map((row) => ("text" in row ? row.text : ""))).toEqual(
        expectedTexts,
      );
      viewed.dispose();
    },
  );

  it("retains positioned gap detection after an out-of-band running setup tool", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const rows = new MemoryRows();
    const disk = cache(rows);
    const { replica, viewed } = owner(disk);
    await replica.prepare(agentId);
    viewed.beginTimelineRequest(agentId, true)({ ...page(41, 80), direction: "tail" });
    viewed.enqueueStreamEvent(agentId, {
      seq: undefined,
      epoch: undefined,
      timestamp: new Date(timestamp),
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          name: "paseo_worktree_setup",
          callId: "setup",
          status: "running",
          error: null,
          detail: {
            type: "worktree_setup",
            worktreePath: "/repo",
            branchName: "branch",
            log: "Installing",
            commands: [],
          },
        },
      },
    });
    viewed.flushStreamAgent(agentId);
    expect(replica.readCursor(agentId)).toEqual({ epoch: "epoch-1", endSeq: 80 });
    await disk.flush();
    expect((await cache(rows).readTimeline(host, agentId))?.range).toBeNull();
    // The saved display page itself grants no source coverage on a fresh owner.
    const fresh = createTimelineReplica({ serverId: host, storage: cache(rows) });
    await fresh.prepare(agentId);
    expect(fresh.readCursor(agentId)).toBeUndefined();
    fresh.dispose();
    const gaps: number[] = [];
    replica.applyEvents(
      agentId,
      [
        {
          seq: 82,
          epoch: "epoch-1",
          timestamp: new Date(timestamp),
          event: {
            type: "timeline",
            provider: "claude",
            item: { type: "assistant_message", text: "row 82", messageId: "message-82" },
          },
        },
      ],
      (_id, cursor, observed) => {
        expect(cursor.endSeq).toBe(80);
        gaps.push(observed!);
      },
    );
    expect(gaps).toEqual([82]);
    viewed.beginTimelineRequest(agentId, true)({ ...page(43, 82), direction: "tail" });
    await disk.flush();
    expect((await cache(rows).readTimeline(host, agentId))?.range).toEqual({
      epoch: "epoch-1",
      startSeq: 43,
      endSeq: 82,
    });
    viewed.dispose();
  });

  it.each(["live-first", "tail-first"] as const)(
    "converges a cold overflow without another live row: %s",
    async (ordering) => {
      useSessionStore.getState().initializeSession(host, null);
      const rows = new MemoryRows();
      const disk = cache(rows);
      disk.commitTimeline(host, agentId, saved());
      await disk.flush();
      const replica = createTimelineReplica({ serverId: host, storage: disk });
      const requests: number[] = [];
      const tailStarted = Promise.withResolvers<void>();
      const releaseTail = Promise.withResolvers<void>();
      const viewed = createViewedTimelineOwner({
        serverId: host,
        replica,
        replaceDemandedAgentIds: () => undefined,
        drainQueuedAgentMessage: () => undefined,
        ports: {
          initialDeliveryMode: "legacy",
          setSubscription: async () => undefined,
          fetchPage: async (id, request) => {
            const seq = request.direction === "after" ? request.cursor.seq : 0;
            requests.push(seq);
            const response =
              seq === 80
                ? { ...page(81, 120, true), window: { minSeq: 1, maxSeq: 199, nextSeq: 200 } }
                : page(200, 200);
            viewed.beginTimelineRequest(id)(response);
            return response;
          },
          fetchLatestTail: async (id) => {
            const apply = viewed.beginTimelineRequest(id, true);
            tailStarted.resolve();
            await releaseTail.promise;
            const response = { ...page(160, 199), direction: "tail" as const };
            apply(response);
            return response;
          },
          reportError: (error) => {
            throw error;
          },
          schedule: () => () => undefined,
        },
      });
      viewed.registerVisibleAgentIds("screen", [agentId]);
      viewed.setConnected(true);
      await tailStarted.promise;
      if (ordering === "live-first") {
        live(viewed, 200);
        viewed.flushStreamAgent(agentId);
      }
      releaseTail.resolve();
      await vi.waitFor(() =>
        expect(replica.readCursor(agentId)?.endSeq).toBeGreaterThanOrEqual(199),
      );
      if (ordering === "tail-first") {
        live(viewed, 200);
        viewed.flushStreamAgent(agentId);
      }
      await vi.waitFor(() => expect(replica.readCursor(agentId)?.endSeq).toBe(200));
      await disk.flush();
      const restored = await cache(rows).readTimeline(host, agentId);
      expect(restored?.items.some((row) => row.timelineCursor?.seq === 200)).toBe(true);
      expect(restored?.range?.endSeq).toBe(200);
      expect(requests).toEqual(ordering === "live-first" ? [80, 199] : [80]);
      // An intentionally requested older window remains detached after synchronization.
      viewed.beginTimelineRequest(
        agentId,
        true,
      )({ ...page(41, 80, true), direction: "tail", mergeWindow: true });
      const before = useSessionStore.getState().sessions[host]?.agentStreamTail.get(agentId);
      live(viewed, 201);
      viewed.flushStreamAgent(agentId);
      expect(useSessionStore.getState().sessions[host]?.agentStreamTail.get(agentId)).toBe(before);
      expect(replica.readCursor(agentId)?.endSeq).not.toBe(201);
      viewed.dispose();
    },
  );

  it.each([false, true])(
    "persists all-unpositioned delivery across restore (pending=%s)",
    async (pending) => {
      useSessionStore.getState().initializeSession(host, null);
      const rows = new MemoryRows();
      const disk = cache(rows);
      const read = Promise.withResolvers<void>();
      const { replica, viewed } = owner({
        readTimeline: async (...args) => {
          await read.promise;
          return disk.readTimeline(...args);
        },
        commitTimeline: (...args) => disk.commitTimeline(...args),
        removeTimeline: (...args) => disk.removeTimeline(...args),
      });
      const preparation = replica.prepare(agentId);
      if (!pending) {
        read.resolve();
        await preparation;
      }
      for (let i = 1; i <= 3; i++) {
        viewed.enqueueStreamEvent(agentId, {
          seq: undefined,
          epoch: undefined,
          timestamp: new Date(timestamp),
          event: {
            type: "timeline",
            provider: "claude",
            item: {
              type: "assistant_message",
              messageId: `legacy-${i}`,
              text: `legacy ${i}`,
            },
          },
        });
        viewed.flushStreamAgent(agentId);
        if (i === 1 && pending) {
          read.resolve();
          await preparation;
        }
        await disk.flush();
        const restored = await cache(rows).readTimeline(host, agentId);
        expect(restored?.range).toBeNull();
        expect(restored?.items).toHaveLength(i);
        expect(replica.readCursor(agentId)).toBeUndefined();
      }
      viewed.dispose();
    },
  );

  it("keeps accepted source coverage and display-only persistence across a delayed restore", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const disk = cache(new MemoryRows());
    const read = Promise.withResolvers<CachedTimeline | undefined>();
    const { replica, viewed } = owner({
      readTimeline: () => read.promise,
      commitTimeline: (...args) => disk.commitTimeline(...args),
      removeTimeline: (...args) => disk.removeTimeline(...args),
    });
    const preparation = replica.prepare(agentId);
    viewed.beginTimelineRequest(agentId, true)({ ...page(1, 3), direction: "tail" });
    viewed.enqueueStreamEvent(agentId, {
      seq: undefined,
      epoch: undefined,
      timestamp: new Date(timestamp),
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", messageId: "legacy", text: "unsequenced" },
      },
    });
    viewed.flushStreamAgent(agentId);
    read.resolve({
      ...saved(),
      items: saved().items.slice(0, 3),
      range: { epoch: "epoch-1", startSeq: 1, endSeq: 3 },
    });
    await preparation;
    expect(replica.readCursor(agentId)).toEqual({ epoch: "epoch-1", endSeq: 3 });
    await disk.flush();
    expect((await disk.readTimeline(host, agentId))?.range).toBeNull();
    expect(
      (await disk.readTimeline(host, agentId))?.items.some(
        (row) => "text" in row && row.text === "unsequenced",
      ),
    ).toBe(true);
    viewed.dispose();
  });

  it.each(["current", "newer", "flag-only"] as const)(
    "settles only the owning initialization after a superseded tail (%s)",
    async (lifetime) => {
      useSessionStore.getState().initializeSession(host, null);
      const disk = cache(new MemoryRows());
      const { replica, viewed } = owner(disk);
      await replica.prepare(agentId);
      viewed.beginTimelineRequest(agentId, true)({ ...page(1, 3), direction: "tail" });
      const key = getInitKey(host, agentId);
      const initial = lifetime === "flag-only" ? undefined : createInitDeferred(key, "tail");
      let settled = false;
      initial?.promise.then(() => {
        settled = true;
        return undefined;
      });
      useSessionStore
        .getState()
        .setInitializingAgents(host, (previous) => new Map(previous).set(agentId, true));
      const accept = viewed.beginTimelineRequest(agentId);
      live(viewed, 4);
      live(viewed, 5);
      viewed.flushStreamAgent(agentId);
      // Replacing an initialization already has its own deferred identity.
      if (lifetime === "newer") createInitDeferred(key, "tail");
      const current = getInitDeferred(key);
      const before = useSessionStore.getState().sessions[host]!;
      accept({ ...page(1, 4), direction: "tail" });
      await Promise.resolve();
      const after = useSessionStore.getState().sessions[host]!;
      expect(after.agentStreamTail.get(agentId)).toBe(before.agentStreamTail.get(agentId));
      expect(after.agentStreamHead.get(agentId)).toBe(before.agentStreamHead.get(agentId));
      expect(replica.readCursor(agentId)).toEqual({ epoch: "epoch-1", endSeq: 5 });
      expect(after.initializingAgents.get(agentId)).toBe(lifetime === "newer");
      expect(settled).toBe(lifetime === "current");
      expect(getInitDeferred(key)).toBe(lifetime === "newer" ? current : undefined);
      resolveInitDeferred(key);
      initial?.resolve();
      viewed.dispose();
    },
  );

  it("preserves display pagination without certifying unsequenced history", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const rows = new MemoryRows();
    const disk = cache(rows);
    const { replica, viewed } = owner(disk);
    await replica.prepare(agentId);
    viewed.beginTimelineRequest(agentId, true)({ ...page(41, 80), direction: "tail" });
    viewed.enqueueStreamEvent(agentId, {
      seq: undefined,
      epoch: undefined,
      timestamp: new Date(timestamp),
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "assistant_message",
          text: "unsequenced",
          messageId: "legacy",
        },
      },
    });
    viewed.flushStreamAgent(agentId);
    const timeline = selectAgentTimelineState(useSessionStore.getState().sessions[host], agentId);
    expect(timeline.status).toBe("synced");
    if (timeline.status !== "synced") throw new Error("Expected painted history");
    expect(timeline.range).toEqual({ epoch: "epoch-1", startSeq: 41, endSeq: 80 });
    expect(replica.readCursor(agentId)).toEqual({ epoch: "epoch-1", endSeq: 80 });
    let requested = false;
    expect(
      await loadOlderAgentHistory(agentId, {
        client: {
          fetchAgentTimeline: async (id, request) => {
            expect(id).toBe(agentId);
            expect(request.cursor).toEqual({ epoch: "epoch-1", seq: 41 });
            requested = true;
            viewed.applyTimelineResponse({ ...page(1, 40), direction: "before", hasOlder: false });
          },
        },
        cursor: timeline.range ?? undefined,
        hasOlder: timeline.older === "available",
        isLoadingOlder: false,
        setInFlight: () => undefined,
      }),
    ).toBe(true);
    expect(requested).toBe(true);
    expect(useSessionStore.getState().sessions[host]?.agentTimelineCursor.get(agentId)).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 80,
    });
    live(viewed, 82);
    viewed.flushStreamAgent(agentId);
    await disk.flush();
    const reopened = await cache(rows).readTimeline(host, agentId);
    expect(reopened?.range).toBeNull();
    expect(reopened?.items).toHaveLength(40);
    expect(reopened?.items.some((row) => (row.source?.startSeq ?? 41) < 41)).toBe(false);
    expect(replica.readCursor(agentId)).toEqual({ epoch: "epoch-1", endSeq: 80 });
    viewed.beginTimelineRequest(agentId, true)({ ...page(43, 82), direction: "tail" });
    await disk.flush();
    expect((await cache(rows).readTimeline(host, agentId))?.range).toEqual({
      epoch: "epoch-1",
      startSeq: 43,
      endSeq: 82,
    });
    viewed.dispose();
  });

  it.each(["live", "cached-live", "page", "empty"] as const)(
    "invalidates old display positions on %s epoch/reset after unpositioned activity",
    async (transition) => {
      useSessionStore.getState().initializeSession(host, null);
      const rows = new MemoryRows();
      const disk = cache(rows);
      if (transition === "cached-live") {
        disk.commitTimeline(host, agentId, {
          ...saved(),
          items: saved().items.slice(40),
          range: { epoch: "epoch-1", startSeq: 41, endSeq: 80 },
          hasOlder: true,
        });
        await disk.flush();
      }
      const { replica, viewed } = owner(disk);
      await replica.prepare(agentId);
      if (transition !== "cached-live")
        viewed.beginTimelineRequest(agentId, true)({ ...page(41, 80), direction: "tail" });
      viewed.enqueueStreamEvent(agentId, {
        seq: undefined,
        epoch: undefined,
        timestamp: new Date(timestamp),
        event: {
          type: "timeline",
          provider: "claude",
          item: { type: "assistant_message", text: "unsequenced", messageId: "legacy" },
        },
      });
      viewed.flushStreamAgent(agentId);
      if (transition === "live" || transition === "cached-live") {
        viewed.enqueueStreamEvent(agentId, {
          seq: 1,
          epoch: "epoch-2",
          timestamp: new Date(timestamp),
          event: {
            type: "timeline",
            provider: "claude",
            item: { type: "assistant_message", text: "new epoch", messageId: "new" },
          },
        });
        viewed.flushStreamAgent(agentId);
      } else {
        const response = page(1, transition === "empty" ? 0 : 1, false, "epoch-2");
        viewed.applyTimelineResponse({
          ...response,
          direction: "tail",
          reset: true,
          hasOlder: false,
          ...(transition === "empty" ? { startCursor: null, endCursor: null } : {}),
        });
      }
      const range = useSessionStore.getState().sessions[host]?.agentTimelineCursor.get(agentId);
      expect(range).toEqual(
        transition === "page" || transition === "live"
          ? { epoch: "epoch-2", startSeq: 1, endSeq: 1 }
          : undefined,
      );
      expect(useSessionStore.getState().sessions[host]?.agentTimelineHasOlder.get(agentId)).toBe(
        false,
      );
      await disk.flush();
      const restored = await cache(rows).readTimeline(host, agentId);
      if (transition === "cached-live") {
        // Until the new epoch is verified, keep the preceding durable baseline.
        expect(restored?.items).toHaveLength(40);
        expect(restored?.range).toEqual({ epoch: "epoch-1", startSeq: 41, endSeq: 80 });
      } else {
        expect(restored?.items).toHaveLength(transition === "empty" ? 0 : 1);
        expect(restored?.range).toEqual(
          transition === "empty" ? null : { epoch: "epoch-2", startSeq: 1, endSeq: 1 },
        );
      }
      viewed.dispose();
    },
  );

  it("does not publish a non-timeline event that changes no displayed fact", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const { replica, viewed } = owner(cache(new MemoryRows()));
    await replica.prepare(agentId);
    viewed.applyTimelineResponse({ ...page(1, 3), direction: "tail" });
    const before = useSessionStore.getState();
    let notifications = 0;
    const unsubscribe = useSessionStore.subscribe(() => notifications++);
    viewed.enqueueStreamEvent(agentId, {
      seq: undefined,
      epoch: undefined,
      timestamp: new Date(timestamp),
      event: { type: "turn_started", provider: "claude", turnId: "turn" },
    });
    viewed.flushStreamAgent(agentId);
    expect(useSessionStore.getState()).toBe(before);
    expect(notifications).toBe(0);
    live(viewed, 4);
    viewed.flushStreamAgent(agentId);
    expect(notifications).toBe(1);
    expect(
      useSessionStore.getState().sessions[host]?.agentTimelineCursor.get(agentId)?.endSeq,
    ).toBe(4);
    unsubscribe();
    viewed.dispose();
  });

  it.each([false, true])(
    "refreshes display-only restarts for unsequenced activity (same message=%s)",
    async (sameMessage) => {
      useSessionStore.getState().initializeSession(host, null);
      const rows = new MemoryRows();
      const disk = cache(rows);
      const { replica, viewed } = owner(disk);
      await replica.prepare(agentId);
      viewed.beginTimelineRequest(agentId, true)({ ...page(31, 40), direction: "tail" });
      viewed.applyTimelineResponse({ ...page(1, 30), direction: "before", hasOlder: false });
      for (let batch = 1; batch <= 3; batch++) {
        viewed.enqueueStreamEvent(agentId, {
          seq: undefined,
          epoch: undefined,
          timestamp: new Date(timestamp),
          event: {
            type: "timeline",
            provider: "claude",
            item: {
              type: "assistant_message",
              text: `legacy ${batch}`,
              messageId: sameMessage ? "message-40" : `legacy-${batch}`,
            },
          },
        });
        viewed.flushStreamAgent(agentId);
        if (batch === 1)
          viewed.applyTimelineResponse({
            ...page(1, 30),
            direction: "before",
            hasOlder: false,
          });
        live(viewed, 40 + batch);
        viewed.flushStreamAgent(agentId);
        await disk.flush();
        const restored = await cache(rows).readTimeline(host, agentId);
        expect(restored?.range).toBeNull();
        expect(replica.readCursor(agentId)).toEqual({ epoch: "epoch-1", endSeq: 40 + batch });
        expect(
          restored?.items.some((row) => "text" in row && row.text.includes(`legacy ${batch}`)),
        ).toBe(true);
        expect(
          restored?.items.some((row) => "text" in row && row.text === `row ${40 + batch}`),
        ).toBe(true);
        expect(restored?.items.some((row) => row.source && row.source.startSeq < 31)).toBe(false);
        expect(restored!.items.length).toBeLessThanOrEqual(40);
      }
      viewed.beginTimelineRequest(agentId, true)({ ...page(31, 43), direction: "tail" });
      await disk.flush();
      const canonical = await cache(rows).readTimeline(host, agentId);
      expect(canonical?.range).toEqual({ epoch: "epoch-1", startSeq: 31, endSeq: 43 });
      expect(canonical?.items.map((row) => ("text" in row ? row.text : row.kind))).toEqual(
        Array.from({ length: 13 }, (_, i) => `row ${i + 31}`),
      );
      // A subsequent positioned gap must keep that certificate through interruption.
      live(viewed, 46);
      viewed.flushStreamAgent(agentId);
      viewed.applyTimelineResponse(page(44, 44, true));
      await disk.flush();
      const partial = await cache(rows).readTimeline(host, agentId);
      expect(partial?.range).toEqual({ epoch: "epoch-1", startSeq: 31, endSeq: 44 });
      expect(partial?.items.some((row) => row.timelineCursor?.seq === 46)).toBe(false);
      viewed.dispose();
    },
  );

  it.each(["captured", "renamed", "commit", "deleted", "disposed", "host-removed"] as const)(
    "settles a real cache restore across identity transfer: %s",
    async (ordering) => {
      const rows = new MemoryRows();
      const seed = cache(rows);
      seed.commitTimeline(host, agentId, saved());
      await seed.flush();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const readRows = rows.read.bind(rows);
      let reads = 0;
      rows.read = async (...args) => {
        reads++;
        if (reads !== 1) return readRows(...args);
        const captured = ordering === "captured" ? await readRows(...args) : undefined;
        started.resolve();
        await release.promise;
        return captured ?? readRows(...args);
      };
      useSessionStore.getState().initializeSession(host, null);
      const disk = cache(rows);
      const { replica, viewed } = owner(disk);
      const preparation = replica.prepare(agentId);
      await started.promise;
      disk.reconcileServerId(host, otherHost);
      useSessionStore.getState().initializeSession(otherHost, null);
      replica.reconcileServerId(otherHost);
      useSessionStore.getState().clearSession(host);
      await disk.flush();
      if (ordering === "commit") {
        disk.commitTimeline(otherHost, agentId, { ...saved(), items: saved().items.slice(40) });
      }
      if (ordering === "deleted") replica.remove(agentId, "deleted");
      if (ordering === "disposed") replica.dispose();
      if (ordering === "host-removed") disk.setHosts([]);
      release.resolve();
      await preparation;
      if (ordering === "deleted" || ordering === "disposed" || ordering === "host-removed") {
        expect(replica.readCursor(agentId)).toBeUndefined();
        expect(
          useSessionStore.getState().sessions[otherHost]?.agentStreamTail.get(agentId) ?? [],
        ).toEqual([]);
        expect(reads).toBe(1);
        viewed.dispose();
        return;
      }
      expect(replica.prepare(agentId)).toBe(preparation);
      expect(replica.readCursor(agentId)).toEqual({ epoch: "epoch-1", endSeq: 80 });
      expect(useSessionStore.getState().sessions[otherHost]?.agentStreamTail.get(agentId)).toEqual(
        ordering === "commit" ? saved().items.slice(40) : saved().items,
      );
      expect(reads).toBe(ordering === "commit" ? 1 : 2);
      viewed.dispose();
    },
  );

  it.each([false, true])(
    "transfers live display and submissions with the owner while restore is pending=%s",
    async (pending) => {
      useSessionStore.getState().initializeSession(host, null);
      const rows = new MemoryRows();
      const disk = cache(rows);
      disk.commitTimeline(host, agentId, saved());
      await disk.flush();
      let reads = 0;
      const read = Promise.withResolvers<CachedTimeline | undefined>();
      const { replica, viewed } = owner({
        readTimeline: () => {
          reads++;
          return read.promise;
        },
        commitTimeline: (...args) => disk.commitTimeline(...args),
        removeTimeline: (...args) => disk.removeTimeline(...args),
      });
      const preparation = replica.prepare(agentId);
      if (!pending) {
        read.resolve(await disk.readTimeline(host, agentId));
        await preparation;
      }
      live(viewed, 81);
      viewed.flushStreamAgent(agentId);
      const message = createUserMessage({
        text: "pending send",
        clientMessageId: "local",
        timestamp: new Date(timestamp),
      });
      replica.beginSubmission(agentId, message, true);
      const before = useSessionStore.getState().sessions[host]!;
      viewed.dispose();
      useSessionStore.getState().initializeSession(otherHost, null);
      disk.reconcileServerId(host, otherHost);
      replica.reconcileServerId(otherHost);
      useSessionStore.getState().clearSession(host);
      const transferred = useSessionStore.getState().sessions[otherHost]!;
      expect(transferred.agentStreamTail.get(agentId)).toBe(before.agentStreamTail.get(agentId));
      expect(transferred.agentStreamHead.get(agentId)).toBe(before.agentStreamHead.get(agentId));
      expect(transferred.messageSubmissions.get(agentId)).toEqual(
        before.messageSubmissions.get(agentId),
      );
      if (pending) read.resolve(await disk.readTimeline(otherHost, agentId));
      await preparation;
      expect(replica.prepare(agentId)).toBe(preparation);
      expect(reads).toBe(pending ? 2 : 1);
      expect(replica.readCursor(agentId)).toEqual({ epoch: "epoch-1", endSeq: 80 });
      const restored = useSessionStore.getState().sessions[otherHost]!;
      const display = [
        ...restored.agentStreamTail.get(agentId)!,
        ...restored.agentStreamHead.get(agentId)!,
      ];
      expect(
        display.some((row) => row.kind === "assistant_message" && row.messageId === "message-81"),
      ).toBe(true);
      expect(
        display.some((row) => row.kind === "user_message" && row.clientMessageId === "local"),
      ).toBe(true);
      expect(useSessionStore.getState().sessions[host]).toBeUndefined();
      expect(replica.rejectSubmission(agentId, "local", true)).toBe("rejected");
      replica.dispose();
    },
  );

  it("paints the real legacy page without resuming its unverified cursor, then replaces it canonically", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const rows = new MemoryRows();
    const id = legacyTimeline.agentId;
    rows.rows.set(`${host}:timeline:${id}`, {
      serverId: host,
      kind: "timeline",
      id,
      payload: JSON.stringify(legacyTimeline),
    });
    const disk = cache(rows);
    const { replica, viewed } = owner(disk);
    await replica.prepare(id);
    expect(
      useSessionStore
        .getState()
        .sessions[host]?.agentStreamTail.get(id)
        ?.map((row) => row.timelineCursor?.seq),
    ).toEqual([34, 69, 1, 34, 35, 69]);
    expect(replica.readCursor(id)).toBeUndefined();
    // Live activity cannot grant certification to the old page.
    viewed.enqueueStreamEvent(id, {
      seq: 70,
      epoch: legacyTimeline.range.epoch,
      timestamp: new Date(timestamp),
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", messageId: "new", text: "new activity" },
      },
    });
    viewed.flushStreamAgent(id);
    await disk.flush();
    expect((await cache(rows).readTimeline(host, id))?.range).toBeNull();

    const requests: string[] = [];
    const canonical = {
      ...page(1, 70, false, legacyTimeline.range.epoch),
      agentId: id,
      direction: "tail" as const,
      hasOlder: false,
      entries: [
        legacyTimeline.items[2],
        legacyTimeline.items[0],
        legacyTimeline.items[4],
        legacyTimeline.items[1],
      ].map((row) => ({
        provider: "claude" as const,
        timestamp: row.timestamp,
        item: {
          type:
            row.kind === "user_message"
              ? ("user_message" as const)
              : ("assistant_message" as const),
          text: row.text,
          messageId: row.messageId,
        },
        seqStart: row.timelineCursor.seq,
        seqEnd: row.timelineCursor.seq,
        sourceSeqRanges: [{ startSeq: row.timelineCursor.seq, endSeq: row.timelineCursor.seq }],
        collapsed: [],
      })),
    };
    canonical.entries.push({
      provider: "claude",
      timestamp,
      item: { type: "assistant_message", text: "new activity", messageId: "new" },
      seqStart: 70,
      seqEnd: 70,
      sourceSeqRanges: [{ startSeq: 70, endSeq: 70 }],
      collapsed: [],
    });
    viewed.attachTransport({
      initialDeliveryMode: "legacy",
      setSubscription: async () => undefined,
      fetchPage: async (_id, request) => {
        requests.push(request.direction);
        viewed.beginTimelineRequest(id)(canonical);
        return { hasNewer: false, endCursor: { epoch: canonical.epoch, seq: 70 } };
      },
      fetchLatestTail: async () => {
        throw new Error("Unexpected extra tail");
      },
      reportError: (error) => {
        throw error;
      },
      schedule: () => () => undefined,
    });
    viewed.registerVisibleAgentIds("workspace", [id]);
    viewed.setConnected(true);
    await vi.waitFor(() => expect(viewed.getAgentTimelineStatus(id)).toBe("ready"));
    expect(requests).toEqual(["tail"]);
    await disk.flush();
    const restored = await cache(rows).readTimeline(host, id);
    expect(restored?.range).toEqual({ epoch: canonical.epoch, startSeq: 1, endSeq: 70 });
    expect(restored?.items.map((row) => row.timelineCursor?.seq)).toEqual([1, 34, 35, 69, 70]);
    expect(
      restored?.items.filter((row) => row.kind === "assistant_message").map((row) => row.text),
    ).toEqual([legacyTimeline.items[0].text, legacyTimeline.items[1].text, "new activity"]);
    viewed.dispose();
  });

  it.each(["short", "reasoning", "empty"] as const)(
    "keeps a short restart page independent of older browsing (%s)",
    async (projection) => {
      const snapshots: CachedTimeline[][] = [];
      for (const browse of [false, true]) {
        useSessionStore.getState().clearSession(host);
        useSessionStore.getState().initializeSession(host, null);
        const rows = new MemoryRows();
        const disk = cache(rows);
        const { replica, viewed } = owner(disk);
        await replica.prepare(agentId);
        const tail = { ...page(31, 70), direction: "tail" as const };
        // Forty projected units hydrate to twenty rows: each three thoughts merge before an answer.
        if (projection !== "short") {
          tail.entries = tail.entries.map((entry, i) => {
            if (i % 4 === 3) return entry;
            const item: TimelineResponsePayload["entries"][number]["item"] =
              projection === "reasoning"
                ? { type: "reasoning", text: `thought ${i}` }
                : { type: "assistant_message", text: "", messageId: `empty-${i}` };
            return { ...entry, item };
          });
        } else {
          tail.entries = tail.entries.slice(30);
          tail.startCursor = { epoch: "epoch-1", seq: 61 };
        }
        viewed.beginTimelineRequest(agentId, true)(tail);
        await disk.flush();
        const initial = await cache(rows).readTimeline(host, agentId);
        expect(initial?.items).toHaveLength(projection === "reasoning" ? 20 : 10);
        const olderEnd = tail.startCursor!.seq - 1;
        if (browse)
          viewed.applyTimelineResponse({
            ...page(1, olderEnd),
            direction: "before",
            hasOlder: false,
            window: tail.window,
          });
        await disk.flush();
        expect(await cache(rows).readTimeline(host, agentId)).toEqual(initial);
        const results: CachedTimeline[] = [];
        for (const end of [71, 75, 115]) {
          const start = results.length === 0 ? 71 : results.at(-1)!.range!.endSeq + 1;
          for (let seq = start; seq <= end; seq++) live(viewed, seq);
          viewed.flushStreamAgent(agentId);
          await disk.flush();
          const snapshot = await cache(rows).readTimeline(host, agentId);
          expect(snapshot?.range).toMatchObject({ epoch: "epoch-1", endSeq: end });
          expect(snapshot?.items.length).toBe(Math.min(40, initial!.items.length + end - 70));
          expect(snapshot?.hasOlder).toBe(true);
          results.push(snapshot!);
        }
        snapshots.push(results);
        viewed.dispose();
        replica.dispose();
        useSessionStore.getState().clearSession(host);
        useSessionStore.getState().initializeSession(host, null);
        const reopened = owner(cache(rows));
        await reopened.replica.prepare(agentId);
        expect(reopened.replica.readCursor(agentId)).toEqual({ epoch: "epoch-1", endSeq: 115 });
        expect(useSessionStore.getState().sessions[host]?.agentStreamTail.get(agentId)).toEqual(
          results[2].items,
        );
        expect(results[2].range?.startSeq).toBe(76);
        reopened.viewed.applyTimelineResponse({ ...page(36, 75), direction: "before" });
        expect(
          useSessionStore.getState().sessions[host]?.agentStreamTail.get(agentId)?.[0],
        ).toMatchObject({
          messageId: "message-36",
          text: "row 36",
        });
        reopened.viewed.dispose();
      }
      expect(snapshots[1]).toEqual(snapshots[0]);
    },
  );

  it.each([
    ["distinct", "old", "new", ["row 2", "row 3"], 2],
    ["same", "same", "same", ["row 1row 2", "row 3"], 1],
    ["idless", undefined, undefined, ["row 1row 2", "row 3"], 1],
  ] as const)(
    "persists complete %s messages at the retained prepend boundary",
    async (_, olderId, newerId, texts, startSeq) => {
      useSessionStore.getState().initializeSession(host, null);
      const rows = new MemoryRows();
      const disk = cache(rows);
      const { replica, viewed } = owner(disk);
      await replica.prepare(agentId);
      const tail = { ...page(2, 2), direction: "tail" as const };
      tail.entries[0].item = { type: "assistant_message", text: "row 2", messageId: newerId };
      viewed.beginTimelineRequest(agentId, true)(tail);
      const older = {
        ...page(1, 1),
        direction: "before" as const,
        hasOlder: false,
        window: tail.window,
      };
      older.entries[0].item = { type: "assistant_message", text: "row 1", messageId: olderId };
      viewed.applyTimelineResponse(older);
      live(viewed, 3);
      viewed.flushStreamAgent(agentId);
      await disk.flush();
      const persisted = await cache(rows).readTimeline(host, agentId);
      expect(
        persisted?.items.map((row) => (row.kind === "assistant_message" ? row.text : row.kind)),
      ).toEqual(texts);
      expect(persisted?.range).toEqual({ epoch: "epoch-1", startSeq, endSeq: 3 });
      expect(persisted?.items[0].source).toEqual(
        startSeq === 1
          ? {
              startSeq: 1,
              chunks: [
                { seq: 1, offset: 0 },
                { seq: 2, offset: 5 },
              ],
            }
          : { startSeq: 2, chunks: [{ seq: 2, offset: 0 }] },
      );
      viewed.dispose();
      replica.dispose();
      useSessionStore.getState().clearSession(host);
      useSessionStore.getState().initializeSession(host, null);
      const reopened = owner(cache(rows));
      await reopened.replica.prepare(agentId);
      expect(useSessionStore.getState().sessions[host]?.agentStreamTail.get(agentId)).toEqual(
        persisted?.items,
      );
      reopened.viewed.dispose();
    },
  );

  it("bounds overlapping tool history to forty complete entries and retrieves earlier tools by source start", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const rows = new MemoryRows();
    const disk = cache(rows);
    const { replica, viewed } = owner(disk);
    await replica.prepare(agentId);
    const response: TimelineResponsePayload = { ...page(1, 60), direction: "tail" };
    const tool = (start: number, end: number): TimelineResponsePayload["entries"][number] => ({
      provider: "claude",
      item: {
        type: "tool_call",
        callId: `tool-${start}`,
        name: "Bash",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: null, output: null },
      },
      timestamp,
      seqStart: start,
      seqEnd: end,
      sourceSeqRanges: [
        { startSeq: start, endSeq: start },
        { startSeq: end, endSeq: end },
      ],
      collapsed: ["tool_lifecycle"],
    });
    for (let start = 1; start <= 20; start++) response.entries[start - 1] = tool(start, 81 - start);
    response.window = { minSeq: 1, maxSeq: 80, nextSeq: 81 };
    response.endCursor = { epoch: "epoch-1", seq: 80 };
    viewed.applyTimelineResponse(response);
    await disk.flush();
    const snapshot = await cache(rows).readTimeline(host, agentId);
    expect(snapshot?.range).toEqual({ epoch: "epoch-1", startSeq: 21, endSeq: 80 });
    expect(snapshot?.items).toHaveLength(40);
    expect(snapshot?.hasOlder).toBe(true);
    // The last accepted event completed an excluded older tool. The retained page still
    // resumes after 80, while older pagination uses source start 21, not completion order.
    viewed.dispose();
    replica.dispose();
    useSessionStore.getState().clearSession(host);
    useSessionStore.getState().initializeSession(host, null);
    const reopenedDisk = cache(rows);
    const reopened = owner(reopenedDisk);
    await reopened.replica.prepare(agentId);
    expect(reopened.replica.readCursor(agentId)).toEqual({ epoch: "epoch-1", endSeq: 80 });
    expect(useSessionStore.getState().sessions[host]?.agentStreamTail.get(agentId)).toHaveLength(
      40,
    );
    reopened.viewed.applyTimelineResponse({
      ...response,
      direction: "before",
      startCursor: { epoch: "epoch-1", seq: 1 },
      endCursor: { epoch: "epoch-1", seq: 20 },
      entries: response.entries.slice(0, 20),
      hasOlder: false,
    });
    const restored = useSessionStore.getState().sessions[host]?.agentStreamTail.get(agentId);
    expect(restored).toHaveLength(60);
    expect(restored?.[0]).toMatchObject({
      kind: "tool_call",
      source: { startSeq: 1 },
      timelineCursor: { seq: 80 },
    });
    expect((await cache(rows).readTimeline(host, agentId))?.items).toHaveLength(40);
    for (let seq = 81; seq <= 120; seq++) live(reopened.viewed, seq);
    // A final page establishes sequencing after the restart; the overlaid events reconcile.
    reopened.viewed.applyTimelineResponse(page(81, 120));
    reopened.viewed.flushStreamAgent(agentId);
    await reopenedDisk.flush();
    const advanced = await cache(rows).readTimeline(host, agentId);
    expect(advanced?.range).toEqual({ epoch: "epoch-1", startSeq: 81, endSeq: 120 });
    expect(advanced?.items).toHaveLength(40);
    reopened.viewed.dispose();
  });

  it.each([
    ["tail", true],
    ["tail", false],
    ["after", true],
    ["after", false],
  ] as const)(
    "shares accepted markdown and following reductions (%s, positioned=%s)",
    async (direction, positioned) => {
      useSessionStore.getState().initializeSession(host, null);
      const rows = new MemoryRows();
      const disk = cache(rows);
      if (direction === "after")
        disk.commitTimeline(host, agentId, {
          ...saved(),
          items: saved().items.slice(0, 1),
          range: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
        });
      await disk.flush();
      const restore = Promise.withResolvers<void>();
      const { replica, viewed } = owner({
        readTimeline: async (...args) => {
          await restore.promise;
          return disk.readTimeline(...args);
        },
        commitTimeline: (...args) => disk.commitTimeline(...args),
        removeTimeline: (...args) => disk.removeTimeline(...args),
      });
      const preparation = replica.prepare(agentId);
      if (direction === "tail") {
        restore.resolve();
        await preparation;
      }
      for (const [seq, text] of [
        [2, "para one\n\n"],
        [3, "para two"],
      ] as const) {
        viewed.enqueueStreamEvent(agentId, {
          seq: positioned ? seq : undefined,
          epoch: positioned ? "epoch-1" : undefined,
          timestamp: new Date(timestamp),
          event: {
            type: "timeline",
            provider: "claude",
            item: {
              type: "assistant_message",
              messageId: "markdown",
              text,
            },
          },
        });
        viewed.flushStreamAgent(agentId);
      }
      restore.resolve();
      await preparation;
      viewed.applyTimelineResponse({
        ...page(2, 3),
        direction,
        entries: [
          {
            ...page(2, 2).entries[0]!,
            item: {
              type: "assistant_message",
              messageId: "markdown",
              text: "para one\n\npara two",
            },
            seqStart: 2,
            seqEnd: 3,
            sourceSeqRanges: [{ startSeq: 2, endSeq: 3 }],
          },
        ],
      });
      const display = () => {
        const session = useSessionStore.getState().sessions[host]!;
        return [
          ...(session.agentStreamTail.get(agentId) ?? []),
          ...(session.agentStreamHead.get(agentId) ?? []),
        ];
      };
      const accepted = await disk.readTimeline(host, agentId);
      expect(accepted?.items).toStrictEqual(display());
      expect(accepted?.items.at(-1)).toBe(display().at(-1));
      expect(display().at(-1)?.source).toEqual({ startSeq: 2, chunks: [{ seq: 3, offset: 0 }] });
      const control = `${agentId}-control`;
      await replica.prepare(control);
      viewed.applyTimelineResponse({ ...page(1, 3), direction: "tail", agentId: control });
      function sendMeasured(id: string, seq: number): number {
        let textReads = 0;
        viewed.enqueueStreamEvent(id, {
          seq,
          epoch: "epoch-1",
          timestamp: new Date(timestamp),
          event: {
            type: "timeline",
            provider: "claude",
            item: {
              type: "assistant_message",
              messageId: `message-${seq}`,
              get text() {
                textReads++;
                return `row ${seq}`;
              },
            },
          },
        });
        viewed.flushStreamAgent(id);
        return textReads;
      }
      for (let seq = 4; seq <= 8; seq++) {
        const singleReductionReads = sendMeasured(control, seq);
        expect(singleReductionReads).toBeGreaterThan(0);
        expect(sendMeasured(agentId, seq)).toBe(singleReductionReads);
        expect((await disk.readTimeline(host, agentId))?.items.at(-1)).toBe(display().at(-1));
      }
      await disk.flush();
      expect((await cache(rows).readTimeline(host, agentId))?.items).toEqual(display());
      viewed.dispose();
    },
  );

  it.each([true, false])(
    "keeps a lagging paragraph separate only until covered (positioned=%s)",
    async (positioned) => {
      useSessionStore.getState().initializeSession(host, null);
      const disk = cache(new MemoryRows());
      const { replica, viewed } = owner(disk);
      await replica.prepare(agentId);
      for (const [seq, text] of [
        [1, "one\n\n"],
        [2, "two"],
        [3, " newer"],
      ] as const) {
        viewed.enqueueStreamEvent(agentId, {
          seq: positioned ? seq : undefined,
          epoch: positioned ? "epoch-1" : undefined,
          timestamp: new Date(timestamp),
          event: {
            type: "timeline",
            provider: "claude",
            item: { type: "assistant_message", messageId: "m", text },
          },
        });
        viewed.flushStreamAgent(agentId);
      }
      const partial = {
        ...page(1, 2, true),
        direction: "tail" as const,
        entries: [
          {
            ...page(1, 1).entries[0]!,
            item: { type: "assistant_message" as const, messageId: "m", text: "one\n\ntwo" },
            seqEnd: 2,
            sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
          },
        ],
      };
      viewed.applyTimelineResponse(partial);
      const display = () => {
        const session = useSessionStore.getState().sessions[host]!;
        return [
          ...(session.agentStreamTail.get(agentId) ?? []),
          ...(session.agentStreamHead.get(agentId) ?? []),
        ];
      };
      expect(display().some((row) => "text" in row && row.text.includes(" newer"))).toBe(true);
      expect((await disk.readTimeline(host, agentId))?.items).not.toEqual(display());
      viewed.applyTimelineResponse({
        ...page(1, 3),
        direction: "tail",
        entries: [
          {
            ...partial.entries[0]!,
            item: { type: "assistant_message", messageId: "m", text: "one\n\ntwo newer" },
            seqEnd: 3,
            sourceSeqRanges: [{ startSeq: 1, endSeq: 3 }],
          },
        ],
      });
      expect(display().map((row) => ("text" in row ? row.text : row.kind))).toEqual([
        "one\n\ntwo newer",
      ]);
      expect((await disk.readTimeline(host, agentId))?.items[0]).toBe(display()[0]);
      live(viewed, 4);
      viewed.flushStreamAgent(agentId);
      expect((await disk.readTimeline(host, agentId))?.items.at(-1)).toBe(display().at(-1));
      viewed.dispose();
    },
  );

  it.each([true, false])(
    "shares canonical same-message segments around a tool (positioned=%s)",
    async (positioned) => {
      useSessionStore.getState().initializeSession(host, null);
      const disk = cache(new MemoryRows());
      const { replica, viewed } = owner(disk);
      await replica.prepare(agentId);
      const tool = {
        type: "tool_call" as const,
        callId: "between",
        name: "Read",
        status: "running" as const,
        error: null,
        detail: { type: "read" as const, filePath: "/repo/file" },
      };
      const entries: TimelineResponsePayload["entries"] = [
        {
          ...page(1, 1).entries[0]!,
          item: { type: "assistant_message", messageId: "m", text: "one\n\ntwo" },
          seqEnd: 2,
          sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
        },
        { ...page(3, 3).entries[0]!, item: tool },
        {
          ...page(4, 4).entries[0]!,
          item: { type: "assistant_message", messageId: "m", text: "three\n\nfour" },
          seqEnd: 5,
          sourceSeqRanges: [{ startSeq: 4, endSeq: 5 }],
        },
      ];
      for (const entry of entries) {
        viewed.enqueueStreamEvent(agentId, {
          seq: positioned ? entry.seqEnd : undefined,
          epoch: positioned ? "epoch-1" : undefined,
          timestamp: new Date(timestamp),
          event: { type: "timeline", provider: "claude", item: entry.item },
        });
        viewed.flushStreamAgent(agentId);
      }
      viewed.applyTimelineResponse({ ...page(1, 5), direction: "tail", entries });
      const session = useSessionStore.getState().sessions[host]!;
      const display = [
        ...(session.agentStreamTail.get(agentId) ?? []),
        ...(session.agentStreamHead.get(agentId) ?? []),
      ];
      const accepted = (await disk.readTimeline(host, agentId))!.items;
      expect(display.map((row) => ("text" in row ? row.text : row.kind))).toEqual([
        "one\n\ntwo",
        "tool_call",
        "three\n\nfour",
      ]);
      expect(new Set(display.map((row) => row.id)).size).toBe(3);
      expect(accepted).toEqual(display);
      for (let i = 0; i < display.length; i++) expect(accepted[i]).toBe(display[i]);
      live(viewed, 6);
      viewed.flushStreamAgent(agentId);
      expect((await disk.readTimeline(host, agentId))?.items.at(-1)).toBe(
        useSessionStore.getState().sessions[host]?.agentStreamHead.get(agentId)?.at(-1),
      );
      viewed.dispose();
    },
  );

  it.each([false, true])(
    "shares accepted rows after synchronization and catch-up (overlay=%s)",
    async (overlay) => {
      useSessionStore.getState().initializeSession(host, null);
      const rows = new MemoryRows();
      const disk = cache(rows);
      const { replica, viewed } = owner(disk);
      await replica.prepare(agentId);
      if (overlay) {
        live(viewed, 3);
        viewed.flushStreamAgent(agentId);
      }
      viewed.applyTimelineResponse({ ...page(1, 3), direction: "tail" });
      const display = () => [
        ...(useSessionStore.getState().sessions[host]?.agentStreamTail.get(agentId) ?? []),
        ...(useSessionStore.getState().sessions[host]?.agentStreamHead.get(agentId) ?? []),
      ];
      const accepted = await disk.readTimeline(host, agentId);
      expect(accepted?.items).toStrictEqual(display());
      expect(accepted?.items.at(-1)).toBe(display().at(-1));
      live(viewed, 4);
      viewed.flushStreamAgent(agentId);
      expect((await disk.readTimeline(host, agentId))?.items.at(-1)).toBe(display().at(-1));
      await disk.flush();
      expect((await cache(rows).readTimeline(host, agentId))?.items).toEqual(display());
      viewed.dispose();
    },
  );

  it.each(["accept", "reject", "handoff"] as const)(
    "keeps submission %s transitions shared through following batches and restart",
    async (operation) => {
      useSessionStore.getState().initializeSession(host, null);
      const rows = new MemoryRows();
      const disk = cache(rows);
      const { replica, viewed } = owner(disk);
      await replica.prepare(agentId);
      viewed.applyTimelineResponse({ ...page(1, 3), direction: "tail" });
      const message = createUserMessage({
        clientMessageId: "submission",
        text: "prompt",
        timestamp: new Date(timestamp),
      });
      if (operation === "handoff") replica.handoffSubmission(agentId, message);
      else replica.beginSubmission(agentId, message, true);
      if (operation === "reject")
        expect(replica.rejectSubmission(agentId, "submission", true)).toBe("rejected");
      else {
        replica.acceptSubmission(agentId, "submission");
        viewed.enqueueStreamEvent(agentId, {
          seq: 4,
          epoch: "epoch-1",
          timestamp: new Date(timestamp),
          event: {
            type: "timeline",
            provider: "claude",
            item: {
              type: "user_message",
              text: "prompt",
              messageId: "provider-message",
              clientMessageId: "submission",
            },
          },
        });
        viewed.flushStreamAgent(agentId);
      }
      const display = () => [
        ...(useSessionStore.getState().sessions[host]?.agentStreamTail.get(agentId) ?? []),
        ...(useSessionStore.getState().sessions[host]?.agentStreamHead.get(agentId) ?? []),
      ];
      for (let seq = operation === "reject" ? 4 : 5; seq <= 14; seq++) {
        live(viewed, seq);
        viewed.flushStreamAgent(agentId);
        expect((await disk.readTimeline(host, agentId))?.items.at(-1)).toBe(display().at(-1));
      }
      await disk.flush();
      expect((await cache(rows).readTimeline(host, agentId))?.items).toEqual(display());
      expect((await cache(rows).readTimeline(host, agentId))?.range?.endSeq).toBe(14);
      viewed.dispose();
    },
  );

  it("reunites a submission with verified history after a cache/live divergence", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const rows = new MemoryRows();
    const disk = cache(rows);
    disk.commitTimeline(host, agentId, saved());
    await disk.flush();
    const { replica, viewed } = owner(disk);
    await replica.prepare(agentId);
    live(viewed, 83);
    viewed.flushStreamAgent(agentId);
    replica.beginSubmission(
      agentId,
      createUserMessage({
        clientMessageId: "during-gap",
        text: "prompt",
        timestamp: new Date(timestamp),
      }),
      true,
    );
    replica.acceptSubmission(agentId, "during-gap");
    await disk.flush();
    expect((await cache(rows).readTimeline(host, agentId))?.range?.endSeq).toBe(80);
    const response = page(81, 83);
    response.entries[1]!.item = {
      type: "user_message",
      text: "prompt",
      messageId: "canonical",
      clientMessageId: "during-gap",
    };
    viewed.applyTimelineResponse(response);
    for (let seq = 84; seq <= 86; seq++) {
      live(viewed, seq);
      viewed.flushStreamAgent(agentId);
      const session = useSessionStore.getState().sessions[host];
      const display = [
        ...(session?.agentStreamTail.get(agentId) ?? []),
        ...(session?.agentStreamHead.get(agentId) ?? []),
      ];
      expect((await disk.readTimeline(host, agentId))?.items.at(-1)).toBe(display.at(-1));
    }
    await disk.flush();
    const restored = await cache(rows).readTimeline(host, agentId);
    expect(restored?.range?.endSeq).toBe(86);
    expect(restored?.items.filter((item) => item.kind === "user_message")).toHaveLength(1);
    viewed.dispose();
  });

  it("replaces a requested window while preserving an unverified live overlay", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const rows = new MemoryRows();
    const disk = cache(rows);
    disk.commitTimeline(host, agentId, saved());
    await disk.flush();
    const { replica, viewed } = owner(disk);
    await replica.prepare(agentId);
    const acceptTail = viewed.beginTimelineRequest(agentId, true);
    live(viewed, 83);
    viewed.flushStreamAgent(agentId);
    const response = { ...page(81, 82), direction: "tail" as const };
    acceptTail(response);
    expect(response.reset).toBe(false);
    const session = useSessionStore.getState().sessions[host];
    expect(
      [
        ...(session?.agentStreamTail.get(agentId) ?? []),
        ...(session?.agentStreamHead.get(agentId) ?? []),
      ].map((item) => item.id),
    ).toEqual(["message-81", "message-82", "message-83"]);
    await disk.flush();
    const restored = await cache(rows).readTimeline(host, agentId);
    expect(restored?.items.map((item) => item.id)).toEqual(["message-81", "message-82"]);
    expect(restored?.range).toEqual({ epoch: "epoch-1", startSeq: 81, endSeq: 82 });
    viewed.dispose();
  });

  it("saves a moving latest page even when that page exceeds 512 KiB and older history is loaded", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const rows = new MemoryRows();
    const disk = cache(rows);
    const { replica, viewed } = owner(disk);
    await replica.prepare(agentId);
    const latest = { ...page(161, 200), direction: "tail" as const };
    for (const entry of latest.entries) {
      entry.item = {
        type: "assistant_message",
        messageId: `message-${entry.seqStart}`,
        text: "x".repeat(20_000),
      };
    }
    viewed.applyTimelineResponse(latest);
    await disk.flush();
    expect((await cache(rows).readTimeline(host, agentId))?.range).toEqual({
      epoch: "epoch-1",
      startSeq: 161,
      endSeq: 200,
    });
    viewed.applyTimelineResponse({ ...page(1, 160), direction: "before", hasOlder: false });
    live(viewed, 201);
    viewed.flushStreamAgent(agentId);
    await disk.flush();
    const savedPage = await cache(rows).readTimeline(host, agentId);
    expect(savedPage?.items).toHaveLength(40);
    expect(savedPage?.items.at(-1)).toMatchObject({ text: "row 201" });
    expect(savedPage?.range).toEqual({ epoch: "epoch-1", startSeq: 162, endSeq: 201 });
    expect(savedPage?.hasOlder).toBe(true);
    viewed.dispose();
    replica.dispose();
    useSessionStore.getState().clearSession(host);
    useSessionStore.getState().initializeSession(host, null);
    const reopenedDisk = cache(rows);
    const reopened = owner(reopenedDisk);
    await reopened.replica.prepare(agentId);
    expect(reopened.replica.readCursor(agentId)).toEqual({ epoch: "epoch-1", endSeq: 201 });
    expect(useSessionStore.getState().sessions[host]?.agentTimelineCursor.get(agentId)).toEqual({
      epoch: "epoch-1",
      startSeq: 162,
      endSeq: 201,
    });
    reopened.viewed.applyTimelineResponse({ ...page(122, 161), direction: "before" });
    await reopenedDisk.flush();
    expect(
      useSessionStore.getState().sessions[host]?.agentStreamTail.get(agentId)?.[0],
    ).toMatchObject({ text: "row 122" });
    expect((await cache(rows).readTimeline(host, agentId))?.range).toEqual({
      epoch: "epoch-1",
      startSeq: 162,
      endSeq: 201,
    });
    reopened.viewed.dispose();
  });

  it("a live row painted before the resume keeps the resume bounded", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const rows = new MemoryRows();
    const disk = cache(rows);
    disk.commitTimeline(host, agentId, saved());
    await disk.flush();
    const calls: string[] = [];
    const replica = createTimelineReplica({ serverId: host, storage: disk });
    const viewed = createViewedTimelineOwner({
      serverId: host,
      replica,
      replaceDemandedAgentIds: () => undefined,
      drainQueuedAgentMessage: () => undefined,
      ports: {
        initialDeliveryMode: "legacy",
        setSubscription: async () => undefined,
        fetchPage: async (_id, request) => {
          const from = request.direction === "after" ? request.cursor.seq : 0;
          calls.push(`page ${request.direction} ${from}`);
          const end = from + 40;
          const hasNewer = end < 600;
          viewed.applyTimelineResponse({
            ...page(from + 1, end, hasNewer),
            window: { minSeq: 1, maxSeq: 600, nextSeq: 601 },
          });
          return { hasNewer, endCursor: { epoch: "epoch-1", seq: end } };
        },
        fetchLatestTail: async () => {
          calls.push("latest-tail");
          viewed.applyTimelineResponse({ ...page(561, 600), direction: "tail", reset: true });
          return { hasNewer: false, endCursor: { epoch: "epoch-1", seq: 600 } };
        },
        reportError: (error) => {
          throw error;
        },
        schedule: () => () => undefined,
      },
    });
    try {
      viewed.registerVisibleAgentIds("workspace", [agentId]);
      await replica.prepare(agentId);
      live(viewed, 590);
      viewed.flushStreamAgent(agentId);
      await disk.flush();
      expect((await cache(rows).readTimeline(host, agentId))?.range).toEqual(saved().range);

      viewed.setConnected(true);
      await vi.waitFor(() => expect(viewed.getAgentTimelineStatus(agentId)).toBe("ready"));
      expect(calls).toEqual(["page after 80", "latest-tail"]);
      await disk.flush();
      const reopened = await cache(rows).readTimeline(host, agentId);
      expect(reopened?.range).toEqual({ epoch: "epoch-1", startSeq: 561, endSeq: 600 });
      expect(reopened?.items.map((item) => ("text" in item ? item.text : null))).toEqual(
        Array.from({ length: 40 }, (_, i) => `row ${561 + i}`),
      );
    } finally {
      viewed.dispose();
    }
  });

  it("invalidates a certified restart on an authoritative empty reset", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const rows = new MemoryRows();
    const disk = cache(rows);
    disk.commitTimeline(host, agentId, saved());
    await disk.flush();
    const { replica, viewed } = owner(disk);
    await replica.prepare(agentId);
    viewed.applyTimelineResponse({
      ...page(1, 0, false, "epoch-2"),
      direction: "tail",
      reset: true,
      startCursor: null,
      endCursor: null,
      hasOlder: false,
    });
    await disk.flush();
    expect(useSessionStore.getState().sessions[host]?.agentStreamTail.get(agentId) ?? []).toEqual(
      [],
    );
    expect(await cache(rows).readTimeline(host, agentId)).toMatchObject({
      agentId,
      items: [],
      range: null,
      hasOlder: false,
    });
    viewed.dispose();
  });

  it.each(["cache-first", "live-first"])(
    "%s keeps new-epoch activity above an old saved baseline",
    async (ordering) => {
      useSessionStore.getState().initializeSession(host, null);
      const rows = new MemoryRows();
      const disk = cache(rows);
      disk.commitTimeline(host, agentId, saved());
      await disk.flush();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { replica, viewed } = owner({
        readTimeline: async (serverId, id) => {
          const result = await disk.readTimeline(serverId, id);
          await gate;
          return result;
        },
        commitTimeline: (...args) => disk.commitTimeline(...args),
        removeTimeline: (...args) => disk.removeTimeline(...args),
      });
      const preparation = replica.prepare(agentId);
      if (ordering === "cache-first") {
        release();
        await preparation;
      }
      viewed.enqueueStreamEvent(agentId, {
        seq: 1,
        epoch: "epoch-2",
        timestamp: new Date(timestamp),
        event: {
          type: "timeline",
          provider: "claude",
          item: { type: "assistant_message", messageId: "new", text: "new activity" },
        },
      });
      viewed.flushStreamAgent(agentId);
      release();
      await preparation;
      const session = useSessionStore.getState().sessions[host];
      expect(
        [
          ...(session?.agentStreamTail.get(agentId) ?? []),
          ...(session?.agentStreamHead.get(agentId) ?? []),
        ].map((item) => ("text" in item ? item.text : null)),
      ).toEqual(["new activity"]);
      await disk.flush();
      expect((await cache(rows).readTimeline(host, agentId))?.range).toEqual(saved().range);
      viewed.applyTimelineResponse({ ...page(1, 1, false, "epoch-2"), reset: true });
      await disk.flush();
      expect((await cache(rows).readTimeline(host, agentId))?.range?.epoch).toBe("epoch-2");
      viewed.dispose();
    },
  );

  it.each(["live-before-cache", "live-after-cache", "queued-before-page"])(
    "%s preserves a certified restart after every catch-up transition",
    async (ordering) => {
      useSessionStore.getState().initializeSession(host, null);
      const rows = new MemoryRows();
      const disk = cache(rows);
      disk.commitTimeline(host, agentId, saved());
      await disk.flush();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { replica, viewed } = owner({
        removeTimeline: () => undefined,
        readTimeline: async (serverId, id) => {
          const snapshot = await disk.readTimeline(serverId, id);
          await gate;
          return snapshot;
        },
        commitTimeline: (serverId, id, value, requireCertified) =>
          disk.commitTimeline(serverId, id, value, requireCertified),
      });
      const preparation = replica.prepare(agentId);
      const restartAt = async (endSeq: number) => {
        await disk.flush();
        const reopened = await cache(rows).readTimeline(host, agentId);
        const startSeq = endSeq === 80 ? 1 : endSeq - 39;
        expect(reopened?.range).toEqual({ epoch: "epoch-1", startSeq, endSeq });
        expect(reopened?.items.map((row) => row.timelineCursor?.seq)).toEqual(
          Array.from({ length: endSeq - startSeq + 1 }, (_, i) => i + startSeq),
        );
      };
      if (ordering === "live-before-cache") {
        live(viewed, 83);
        viewed.flushStreamAgent(agentId);
        await restartAt(80);
      }
      release();
      await preparation;
      await restartAt(80);
      if (ordering !== "live-before-cache") live(viewed, 83);
      if (ordering === "live-after-cache") viewed.flushStreamAgent(agentId);
      await restartAt(80);
      // Owner flushes the queued live batch before accepting the page.
      viewed.applyTimelineResponse(page(81, 81, true));
      await restartAt(81);
      viewed.applyTimelineResponse(page(82, 82));
      await restartAt(82);
      viewed.applyTimelineResponse(page(83, 83));
      await restartAt(83);
      const session = useSessionStore.getState().sessions[host];
      expect(
        [
          ...(session?.agentStreamTail.get(agentId) ?? []),
          ...(session?.agentStreamHead.get(agentId) ?? []),
        ].map((row) => row.timelineCursor?.seq),
      ).toEqual(Array.from({ length: 83 }, (_, i) => i + 1));
      viewed.dispose();
      replica.dispose();
    },
  );

  it("settles local identity and attachments through the same publication and restart boundary", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const rows = new MemoryRows();
    const disk = cache(rows);
    disk.commitTimeline(host, agentId, saved());
    await disk.flush();
    const { replica, viewed } = owner(disk);
    await replica.prepare(agentId);
    const message = createUserMessage({
      clientMessageId: "submission",
      text: "local prompt",
      timestamp: new Date(timestamp),
      attachments: [{ type: "text", mimeType: "text/plain", text: "attachment" }],
      images: [
        {
          id: "image",
          mimeType: "image/png",
          storageType: "native-file",
          storageKey: "/saved/image.png",
          createdAt: 1,
        },
      ],
    });
    replica.beginSubmission(agentId, message, true);
    await disk.flush();
    expect((await cache(rows).readTimeline(host, agentId))?.items).toHaveLength(80);
    const canonical = page(81, 81);
    canonical.entries[0].item = {
      type: "user_message",
      text: "canonical prompt",
      messageId: "submission",
    };
    viewed.applyTimelineResponse(canonical);
    expect(replica.rejectSubmission(agentId, "submission", true)).toBe("accepted");
    await disk.flush();
    expect(
      useSessionStore.getState().sessions[host]?.agentStreamTail.get(agentId)?.at(-1),
    ).toMatchObject({
      id: message.id,
      text: "local prompt",
      attachments: message.attachments,
    });
    const restored = await cache(rows).readTimeline(host, agentId);
    expect(restored?.range).toEqual({ epoch: "epoch-1", startSeq: 42, endSeq: 81 });
    expect(restored?.items.at(-1)).toMatchObject({
      attachments: message.attachments,
      images: message.images,
    });
    replica.beginSubmission(
      agentId,
      createUserMessage({
        clientMessageId: "rejected",
        text: "rejected",
        timestamp: new Date(timestamp),
      }),
      true,
    );
    expect(replica.rejectSubmission(agentId, "rejected", true)).toBe("rejected");
    await disk.flush();
    expect((await cache(rows).readTimeline(host, agentId))?.items).toHaveLength(40);
    viewed.dispose();
  });

  it("ends removed work, accepts a fresh lifetime, and isolates the other host", async () => {
    useSessionStore.getState().initializeSession(host, null);
    useSessionStore.getState().initializeSession(otherHost, null);
    const rows = new MemoryRows();
    const disk = cache(rows);
    disk.commitTimeline(host, agentId, saved());
    disk.commitTimeline(otherHost, agentId, saved());
    await disk.flush();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const removed = owner({
      removeTimeline: (serverId, id) => disk.removeTimeline(serverId, id),
      readTimeline: async () => {
        await gate;
        return saved();
      },
      commitTimeline: (serverId, id, value, requireCertified) =>
        disk.commitTimeline(serverId, id, value, requireCertified),
    });
    const other = owner(disk, otherHost);
    const pending = removed.replica.prepare(agentId);
    live(removed.viewed, 81);
    removed.replica.remove(agentId, "deleted");
    release();
    await pending;
    removed.viewed.applyTimelineResponse(page(81, 81));
    removed.viewed.dispose();
    await disk.flush();
    expect(await cache(rows).readTimeline(host, agentId)).toBeUndefined();
    expect(useSessionStore.getState().sessions[host]?.agentStreamTail.has(agentId)).toBe(false);
    expect(useSessionStore.getState().sessions[host]?.agentStreamHead.has(agentId)).toBe(false);
    removed.replica.acceptAgent(agentId);
    removed.viewed.applyTimelineResponse({
      ...page(1, 1, false, "epoch-2"),
      direction: "tail",
      reset: true,
    });
    await disk.flush();
    expect((await cache(rows).readTimeline(host, agentId))?.range).toEqual({
      epoch: "epoch-2",
      startSeq: 1,
      endSeq: 1,
    });
    await other.replica.prepare(agentId);
    other.viewed.applyTimelineResponse(page(81, 81));
    await disk.flush();
    expect((await cache(rows).readTimeline(otherHost, agentId))?.range?.endSeq).toBe(81);
    other.viewed.dispose();
  });

  it("replaces an old epoch with a smaller verified epoch while retaining pending local submissions", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const rows = new MemoryRows();
    const disk = cache(rows);
    disk.commitTimeline(host, agentId, saved());
    await disk.flush();
    const { replica, viewed } = owner(disk);
    await replica.prepare(agentId);
    const local = createUserMessage({
      clientMessageId: "pending",
      text: "pending",
      timestamp: new Date(timestamp),
    });
    replica.beginSubmission(agentId, local, true);
    viewed.applyTimelineResponse({
      ...page(1, 1, false, "epoch-2"),
      direction: "tail",
      reset: true,
      hasOlder: false,
    });
    await disk.flush();
    const reopened = await cache(rows).readTimeline(host, agentId);
    expect(reopened?.range).toEqual({ epoch: "epoch-2", startSeq: 1, endSeq: 1 });
    expect(reopened?.items).toHaveLength(1);
    expect(useSessionStore.getState().sessions[host]?.agentStreamTail.get(agentId)).toContainEqual(
      local,
    );
    viewed.dispose();
  });
  it("keeps pending submissions across a live epoch reset", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const rows = new MemoryRows();
    const disk = cache(rows);
    const { replica, viewed } = owner(disk);
    viewed.applyTimelineResponse({
      ...page(1, 1),
      direction: "tail",
      reset: true,
      hasOlder: false,
    });
    const local = createUserMessage({
      clientMessageId: "pending",
      text: "pending",
      timestamp: new Date(timestamp),
    });
    replica.beginSubmission(agentId, local, true);
    replica.applyEvents(
      agentId,
      [
        {
          seq: 1,
          epoch: "epoch-2",
          timestamp: new Date(timestamp),
          event: {
            type: "timeline",
            provider: "claude",
            item: { type: "assistant_message", text: "new epoch", messageId: "new" },
          },
        },
      ],
      () => undefined,
    );
    const session = useSessionStore.getState().sessions[host];
    expect([
      ...(session?.agentStreamTail.get(agentId) ?? []),
      ...(session?.agentStreamHead.get(agentId) ?? []),
    ]).toContainEqual(local);
    await disk.flush();
    expect((await cache(rows).readTimeline(host, agentId))?.range).toEqual({
      epoch: "epoch-2",
      startSeq: 1,
      endSeq: 1,
    });
    viewed.dispose();
  });

  it("a removal during publication wins over the transition's write-behind", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const rows = new MemoryRows();
    const disk = cache(rows);
    const { replica, viewed } = owner(disk);
    let removed = false;
    const stop = useSessionStore.subscribe((state) => {
      if (!removed && state.sessions[host]?.agentTimelineCursor.has(agentId)) {
        removed = true;
        replica.remove(agentId, "deleted");
      }
    });
    viewed.applyTimelineResponse({ ...page(1, 1), direction: "tail", reset: true });
    stop();
    await disk.flush();
    expect(await cache(rows).readTimeline(host, agentId)).toBeUndefined();
    expect(useSessionStore.getState().sessions[host]?.agentStreamTail.has(agentId)).toBe(false);
    viewed.dispose();
  });

  it("keeps a certified attachment-bearing replacement above an unread baseline", async () => {
    useSessionStore.getState().initializeSession(host, null);
    const rows = new MemoryRows();
    const disk = cache(rows);
    disk.commitTimeline(host, agentId, saved());
    await disk.flush();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { replica, viewed } = owner({
      removeTimeline: (serverId, id) => disk.removeTimeline(serverId, id),
      readTimeline: async () => {
        await gate;
        return saved();
      },
      commitTimeline: (serverId, id, value, requireCertified) =>
        disk.commitTimeline(serverId, id, value, requireCertified),
    });
    const pending = replica.prepare(agentId);
    const local = createUserMessage({
      clientMessageId: "attachment",
      text: "prompt",
      timestamp: new Date(timestamp),
      attachments: [{ type: "text", text: "data", mimeType: "text/plain" }],
    });
    replica.beginSubmission(agentId, local, true);
    const response = { ...page(81, 81), direction: "tail" as const, reset: true };
    response.entries[0].item = { type: "user_message", messageId: "attachment", text: "prompt" };
    viewed.applyTimelineResponse(response);
    await disk.flush();
    expect((await cache(rows).readTimeline(host, agentId))?.range).toEqual({
      epoch: "epoch-1",
      startSeq: 81,
      endSeq: 81,
    });
    release();
    await pending;
    await disk.flush();
    expect((await cache(rows).readTimeline(host, agentId))?.items.at(-1)).toMatchObject({
      attachments: local.attachments,
    });
    viewed.dispose();
  });
});
