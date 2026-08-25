import { describe, expect, it } from "vitest";
import {
  INVENTORY_SCHEMA_VERSION,
  InventorySnapshotError,
  InventorySnapshotService,
  MAX_SNAPSHOTS_PER_DAEMON,
  type InventorySnapshotRequest,
  type InventorySnapshotServiceOptions,
  type InventorySessionEntry,
} from "./inventory-snapshot-service.js";

function entry(
  index: number,
  overrides: Partial<InventorySessionEntry> = {},
): InventorySessionEntry {
  return {
    backend: "paseo",
    native_id: `session-${String(index).padStart(4, "0")}`,
    provider: "claude",
    status_raw: "idle",
    archived: false,
    archived_at: null,
    internal: false,
    live: false,
    cwd: `/worktree/${index}`,
    created_at: "2026-08-10T00:00:00.000Z",
    updated_at: "2026-08-10T00:00:00.000Z",
    persistence_session_id: `provider-${index}`,
    ...overrides,
  };
}

function serviceFor(
  entries: InventorySessionEntry[],
  options: InventorySnapshotServiceOptions = {},
) {
  return new InventorySnapshotService(() => entries, options);
}

async function page(
  service: InventorySnapshotService,
  request: InventorySnapshotRequest,
  clientId = "client-a",
) {
  return service.page(request, clientId);
}

async function allIds(service: InventorySnapshotService, limit: number) {
  let result = await page(service, { limit });
  const snapshotId = result.snapshot_id;
  const ids = result.entries.map((item) => item.native_id);
  const cursors: string[] = [];
  while (result.has_more) {
    expect(result.next_cursor).not.toBeNull();
    cursors.push(result.next_cursor!);
    result = await page(service, { snapshot_id: snapshotId, cursor: result.next_cursor!, limit });
    ids.push(...result.entries.map((item) => item.native_id));
  }
  return { snapshotId, ids, cursors };
}

async function expectErrorCode(
  action: () => unknown | Promise<unknown>,
  code: InventorySnapshotError["code"],
): Promise<void> {
  try {
    await action();
    throw new Error("Expected inventory snapshot failure");
  } catch (error) {
    expect(error).toBeInstanceOf(InventorySnapshotError);
    expect((error as InventorySnapshotError).code).toBe(code);
  }
}

describe("InventorySnapshotService", () => {
  it.each([0, 1, 199, 200, 201, 401])("materializes %i sessions", async (count) => {
    const result = await allIds(
      serviceFor(Array.from({ length: count }, (_, index) => entry(index))),
      200,
    );
    expect(result.ids).toHaveLength(count);
    expect(new Set(result.ids)).toHaveLength(count);
    expect(result.ids).toEqual([...result.ids].sort());
  });

  it("returns three pages with all identities exactly once and no cursor loop", async () => {
    const result = await allIds(
      serviceFor(Array.from({ length: 401 }, (_, index) => entry(index))),
      200,
    );
    expect(result.cursors).toHaveLength(2);
    expect(new Set(result.cursors)).toHaveLength(2);
  });

  it("fails closed for duplicate or malformed canonical state", async () => {
    await expectErrorCode(
      () => page(serviceFor([entry(1), entry(1)]), {}),
      "inventory_snapshot_conflict",
    );
    await expectErrorCode(
      () => page(serviceFor([entry(1, { updated_at: "not-a-timestamp" })]), {}),
      "inventory_snapshot_conflict",
    );
  });

  it("keeps creation, deletion, archive, and lifecycle mutations out of an existing snapshot", async () => {
    const source = [entry(1), entry(2), entry(3)];
    const service = serviceFor(source);
    const first = await page(service, { limit: 1 });
    source.splice(1, 1);
    source.push(
      entry(4, { status_raw: "closed", archived: true, archived_at: "2026-08-10T00:01:00.000Z" }),
    );
    const second = await page(service, {
      snapshot_id: first.snapshot_id,
      cursor: first.next_cursor!,
      limit: 3,
    });
    expect(second.entries.map((item) => item.native_id)).toEqual(["session-0002", "session-0003"]);
  });

  it("replays the same snapshot/cursor deterministically", async () => {
    const service = serviceFor([entry(1), entry(2), entry(3)]);
    const first = await page(service, { limit: 1 });
    const replay = { snapshot_id: first.snapshot_id, cursor: first.next_cursor!, limit: 1 };
    await expect(page(service, replay)).resolves.toEqual(await page(service, replay));
  });

  it("rejects forged, incomplete, foreign-snapshot, and looping cursors", async () => {
    const source = [entry(1), entry(2), entry(3)];
    const service = serviceFor(source);
    const first = await page(service, { limit: 1 });
    source[0].status_raw = "running";
    const second = await page(service, { limit: 1 });
    await expectErrorCode(
      () =>
        page(service, { snapshot_id: second.snapshot_id, cursor: first.next_cursor!, limit: 1 }),
      "invalid_inventory_cursor",
    );
    await expect(page(service, { snapshot_id: first.snapshot_id })).rejects.toBeInstanceOf(
      InventorySnapshotError,
    );
    await expect(page(service, { cursor: first.next_cursor! })).rejects.toBeInstanceOf(
      InventorySnapshotError,
    );
    await expectErrorCode(
      () => page(service, { snapshot_id: first.snapshot_id, cursor: "not-a-cursor" }),
      "invalid_inventory_cursor",
    );
    await expectErrorCode(
      () =>
        page(service, {
          snapshot_id: first.snapshot_id,
          cursor: `${first.next_cursor}!`,
          limit: 1,
        }),
      "invalid_inventory_cursor",
    );
    const loopCursor = (
      service as unknown as { encodeCursor(id: string, offset: number, clientId: string): string }
    ).encodeCursor(first.snapshot_id, 0, "client-a");
    await expectErrorCode(
      () => page(service, { snapshot_id: first.snapshot_id, cursor: loopCursor, limit: 1 }),
      "invalid_inventory_cursor",
    );
  });

  it("expires snapshots but distinguishes eviction/daemon-restart from expiry", async () => {
    let now = 0;
    const service = serviceFor([entry(1), entry(2)], { now: () => now, ttlMs: 10 });
    const first = await page(service, { limit: 1 });
    now = 11;
    await expectErrorCode(
      () => page(service, { snapshot_id: first.snapshot_id, cursor: first.next_cursor!, limit: 1 }),
      "inventory_snapshot_expired",
    );
    const restarted = serviceFor([entry(1), entry(2)]);
    await expectErrorCode(
      () =>
        page(restarted, { snapshot_id: first.snapshot_id, cursor: first.next_cursor!, limit: 1 }),
      "inventory_snapshot_not_found",
    );
  });

  it("uses a bounded LRU cache, evicts the oldest snapshot, and skips single-page cache entries", async () => {
    const source = [entry(1), entry(2)];
    const service = serviceFor(source, { maxSnapshots: 2 });
    const snapshots = [];
    for (const index of [0, 1]) {
      source[0].updated_at = `2026-08-10T00:00:0${index}.000Z`;
      snapshots.push(await page(service, { limit: 1 }));
    }
    await page(service, {
      snapshot_id: snapshots[0].snapshot_id,
      cursor: snapshots[0].next_cursor!,
      limit: 1,
    });
    source[0].updated_at = "2026-08-10T00:00:02.000Z";
    snapshots.push(await page(service, { limit: 1 }));
    await expectErrorCode(
      () =>
        page(service, {
          snapshot_id: snapshots[1].snapshot_id,
          cursor: snapshots[1].next_cursor!,
          limit: 1,
        }),
      "inventory_snapshot_not_found",
    );
    await expect(
      page(service, {
        snapshot_id: snapshots[2].snapshot_id,
        cursor: snapshots[2].next_cursor!,
        limit: 1,
      }),
    ).resolves.toMatchObject({ has_more: false });

    const single = serviceFor([entry(99)]);
    const onePage = await page(single, { limit: 200 });
    expect(onePage.has_more).toBe(false);
    const syntheticCursor = (
      single as unknown as { encodeCursor(id: string, offset: number, clientId: string): string }
    ).encodeCursor(onePage.snapshot_id, 1, "client-a");
    await expectErrorCode(
      () =>
        page(single, {
          snapshot_id: onePage.snapshot_id,
          cursor: syntheticCursor,
          limit: 1,
        }),
      "inventory_snapshot_not_found",
    );
    expect(MAX_SNAPSHOTS_PER_DAEMON).toBeGreaterThan(0);
  });

  it("keeps the global cache bounded at 64 snapshots across client identities", async () => {
    const source = [entry(1), entry(2)];
    const service = serviceFor(source);
    const snapshots = [];
    for (let index = 0; index <= MAX_SNAPSHOTS_PER_DAEMON; index += 1) {
      source[0].cwd = `/worktree/cache-${index}`;
      snapshots.push(await page(service, { limit: 1 }, `client-${index}`));
    }
    await expectErrorCode(
      () =>
        page(
          service,
          {
            snapshot_id: snapshots[0].snapshot_id,
            cursor: snapshots[0].next_cursor!,
            limit: 1,
          },
          "client-0",
        ),
      "inventory_snapshot_not_found",
    );
    await expect(
      page(
        service,
        {
          snapshot_id: snapshots.at(-1)!.snapshot_id,
          cursor: snapshots.at(-1)!.next_cursor!,
          limit: 1,
        },
        `client-${MAX_SNAPSHOTS_PER_DAEMON}`,
      ),
    ).resolves.toMatchObject({ has_more: false });
  });

  it("permits reconnect with the same client id before TTL and rejects another client", async () => {
    const service = serviceFor([entry(1), entry(2)]);
    const first = await page(service, { limit: 1 }, "stable-client-id");
    await expect(
      page(
        service,
        { snapshot_id: first.snapshot_id, cursor: first.next_cursor!, limit: 1 },
        "stable-client-id",
      ),
    ).resolves.toMatchObject({ has_more: false });
    await expectErrorCode(
      () =>
        page(
          service,
          { snapshot_id: first.snapshot_id, cursor: first.next_cursor!, limit: 1 },
          "other-client",
        ),
      "inventory_snapshot_not_found",
    );

    const sameSnapshotForOtherClient = await page(service, { limit: 1 }, "other-client");
    expect(sameSnapshotForOtherClient.snapshot_id).toBe(first.snapshot_id);
    await expectErrorCode(
      () =>
        page(
          service,
          { snapshot_id: first.snapshot_id, cursor: first.next_cursor!, limit: 1 },
          "other-client",
        ),
      "invalid_inventory_cursor",
    );
  });

  it("hashes canonically and sorts with environment-independent code units", async () => {
    const serviceA = serviceFor([entry(2), entry(1)]);
    const first = entry(1);
    const second = entry(2);
    const serviceB = serviceFor([
      {
        updated_at: first.updated_at,
        native_id: first.native_id,
        backend: first.backend,
        archived: first.archived,
        provider: first.provider,
        status_raw: first.status_raw,
        archived_at: first.archived_at,
        internal: first.internal,
        live: first.live,
        cwd: first.cwd,
        created_at: first.created_at,
        persistence_session_id: first.persistence_session_id,
      },
      {
        updated_at: second.updated_at,
        native_id: second.native_id,
        backend: second.backend,
        archived: second.archived,
        provider: second.provider,
        status_raw: second.status_raw,
        archived_at: second.archived_at,
        internal: second.internal,
        live: second.live,
        cwd: second.cwd,
        created_at: second.created_at,
        persistence_session_id: second.persistence_session_id,
      },
    ]);
    const pageA = await page(serviceA, { limit: 200 });
    const pageB = await page(serviceB, { limit: 200 });
    expect(pageA.snapshot_id).toBe(pageB.snapshot_id);
    expect(pageA.entries.map((item) => item.native_id)).toEqual(["session-0001", "session-0002"]);

    const localeSensitive = serviceFor([
      entry(1, { native_id: "\u00e4" }),
      entry(2, { native_id: "Z" }),
    ]);
    expect(
      (await page(localeSensitive, { limit: 200 })).entries.map((item) => item.native_id),
    ).toEqual(["Z", "\u00e4"]);
  });

  it("includes scope records and preserves explicit provenance", async () => {
    const result = await page(
      serviceFor([
        entry(1, { live: true, status_raw: "running" }),
        entry(2, { live: false, status_raw: "running" }),
        entry(3, {
          provider: "unavailable-provider",
          internal: true,
          status_raw: "error",
          archived: true,
          archived_at: "2026-08-10T00:01:00.000Z",
        }),
      ]),
      { limit: 200 },
    );
    expect(result.entries).toMatchObject([
      { native_id: "session-0001", live: true, status_raw: "running" },
      { native_id: "session-0002", live: false, status_raw: "running" },
      { native_id: "session-0003", internal: true, archived: true },
    ]);
    expect(result.schema_version).toBe(INVENTORY_SCHEMA_VERSION);
  });

  it("only invokes the source read path and never a mutation path", async () => {
    let reads = 0;
    let mutations = 0;
    const source = { read: () => ((reads += 1), [entry(1)]), mutate: () => (mutations += 1) };
    await page(new InventorySnapshotService(source.read), {});
    expect(reads).toBe(1);
    expect(mutations).toBe(0);
  });
});
