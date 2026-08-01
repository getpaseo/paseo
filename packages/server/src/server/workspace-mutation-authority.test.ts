import { describe, expect, test } from "vitest";

import { WorkspaceMutationAuthority } from "./workspace-mutation-authority.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createAuthority() {
  let now = Date.parse("2026-08-01T12:00:00.000Z");
  let nextLease = 1;
  return {
    authority: new WorkspaceMutationAuthority({
      leaseDurationMs: 30_000,
      now: () => now,
      generateLeaseId: () => `lease-${nextLease++}`,
    }),
    advanceBy(ms: number) {
      now += ms;
    },
  };
}

describe("WorkspaceMutationAuthority", () => {
  test("acquires, renews, and releases an owner lease", async () => {
    const { authority, advanceBy } = createAuthority();
    const acquired = await authority.acquire({ workspaceId: "workspace-1", ownerId: "client-1" });

    expect(acquired).toEqual({
      ok: true,
      value: {
        workspaceId: "workspace-1",
        leaseId: "lease-1",
        fence: 1,
        expiresAt: "2026-08-01T12:00:30.000Z",
      },
    });
    expect(await authority.acquire({ workspaceId: "workspace-1", ownerId: "client-2" })).toEqual({
      ok: false,
      code: "authority_held",
    });

    advanceBy(10_000);
    expect(
      await authority.renew({
        workspaceId: "workspace-1",
        ownerId: "client-1",
        leaseId: "lease-1",
        fence: 1,
      }),
    ).toEqual({
      ok: true,
      value: {
        workspaceId: "workspace-1",
        leaseId: "lease-1",
        fence: 1,
        expiresAt: "2026-08-01T12:00:40.000Z",
      },
    });
    expect(
      await authority.release({
        workspaceId: "workspace-1",
        ownerId: "client-1",
        leaseId: "lease-1",
        fence: 1,
      }),
    ).toEqual({
      ok: true,
      value: {
        workspaceId: "workspace-1",
        leaseId: "lease-1",
        fence: 1,
        expiresAt: "2026-08-01T12:00:40.000Z",
      },
    });
  });

  test("rejects stale owner, lease, fence, and expired lease references", async () => {
    const { authority, advanceBy } = createAuthority();
    await authority.acquire({ workspaceId: "workspace-1", ownerId: "client-1" });

    expect(
      await authority.renew({
        workspaceId: "workspace-1",
        ownerId: "client-2",
        leaseId: "lease-1",
        fence: 1,
      }),
    ).toEqual({ ok: false, code: "owner_mismatch" });
    expect(
      await authority.renew({
        workspaceId: "workspace-1",
        ownerId: "client-1",
        leaseId: "stale-lease",
        fence: 1,
      }),
    ).toEqual({ ok: false, code: "lease_mismatch" });
    expect(
      await authority.renew({
        workspaceId: "workspace-1",
        ownerId: "client-1",
        leaseId: "lease-1",
        fence: 0,
      }),
    ).toEqual({ ok: false, code: "fence_mismatch" });

    advanceBy(30_000);
    expect(
      await authority.renew({
        workspaceId: "workspace-1",
        ownerId: "client-1",
        leaseId: "lease-1",
        fence: 1,
      }),
    ).toEqual({ ok: false, code: "lease_expired" });
  });

  test("increments the fence when authority transfers after expiry", async () => {
    const { authority, advanceBy } = createAuthority();
    await authority.acquire({ workspaceId: "workspace-1", ownerId: "client-1" });
    advanceBy(30_000);

    expect(await authority.acquire({ workspaceId: "workspace-1", ownerId: "client-2" })).toEqual({
      ok: true,
      value: {
        workspaceId: "workspace-1",
        leaseId: "lease-2",
        fence: 2,
        expiresAt: "2026-08-01T12:01:00.000Z",
      },
    });
    expect(
      await authority.commit(
        {
          workspaceId: "workspace-1",
          ownerId: "client-1",
          leaseId: "lease-1",
          fence: 1,
        },
        async () => "must-not-run",
      ),
    ).toEqual({ ok: false, code: "lease_mismatch" });
  });

  test("invalidates leases when daemon-owned authority state is recreated", async () => {
    const first = createAuthority().authority;
    await first.acquire({ workspaceId: "workspace-1", ownerId: "client-1" });

    const restarted = createAuthority().authority;
    expect(
      await restarted.commit(
        {
          workspaceId: "workspace-1",
          ownerId: "client-1",
          leaseId: "lease-1",
          fence: 1,
        },
        async () => "must-not-run",
      ),
    ).toEqual({ ok: false, code: "authority_not_found" });
  });

  test("serializes release before a stale prepared commit", async () => {
    const { authority } = createAuthority();
    await authority.acquire({ workspaceId: "workspace-1", ownerId: "client-1" });
    const reference = {
      workspaceId: "workspace-1",
      ownerId: "client-1",
      leaseId: "lease-1",
      fence: 1,
    };
    let mutated = false;

    const release = authority.release(reference);
    const commit = authority.commit(reference, async () => {
      mutated = true;
    });

    expect(await release).toMatchObject({ ok: true });
    expect(await commit).toEqual({ ok: false, code: "authority_not_found" });
    expect(mutated).toBe(false);
  });

  test("keeps same-workspace commits in one lane and rechecks expiry", async () => {
    const { authority, advanceBy } = createAuthority();
    await authority.acquire({ workspaceId: "workspace-1", ownerId: "client-1" });
    const reference = {
      workspaceId: "workspace-1",
      ownerId: "client-1",
      leaseId: "lease-1",
      fence: 1,
    };
    const firstMutation = deferred<string>();
    const firstStarted = deferred<void>();
    const order: string[] = [];

    const firstCommit = authority.commit(reference, async () => {
      order.push("first-started");
      firstStarted.resolve(undefined);
      const value = await firstMutation.promise;
      order.push("first-finished");
      return value;
    });
    const secondCommit = authority.commit(reference, async () => {
      order.push("second-started");
      return "second";
    });

    await firstStarted.promise;
    expect(order).toEqual(["first-started"]);
    advanceBy(30_000);
    firstMutation.resolve("first");

    expect(await firstCommit).toEqual({ ok: true, value: "first" });
    expect(await secondCommit).toEqual({ ok: false, code: "lease_expired" });
    expect(order).toEqual(["first-started", "first-finished"]);
  });
});
