import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  DeliveryDispatchCoordinator,
  DeliveryLedger,
  DeliveryLedgerError,
  deliveryLedgerFilePath,
} from "./delivery-ledger.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function createLedger(): Promise<{ home: string; ledger: DeliveryLedger }> {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-deliveries-"));
  homes.push(home);
  return { home, ledger: new DeliveryLedger(home) };
}

test("persists pending deliveries and recovers them after a new ledger instance", async () => {
  const { home, ledger } = await createLedger();
  const sent = await ledger.send("owner", {
    deliveryId: "delivery-one",
    payload: { event: "finished", value: 3 },
  });

  expect(sent).toMatchObject({ created: true, delivery: { deliveryId: "delivery-one" } });
  expect(await ledger.get("owner")).toMatchObject({
    deliveries: [sent.delivery],
    delivery: null,
    nextCursor: null,
  });

  const recovered = new DeliveryLedger(home);
  await expect(recovered.get("owner")).resolves.toMatchObject({
    deliveries: [sent.delivery],
  });
});

test("loads legacy pull-only records and supplies native defaults in memory", async () => {
  const { home } = await createLedger();
  await writeFile(
    deliveryLedgerFilePath(home, "owner"),
    JSON.stringify({
      version: 1,
      ownerId: "owner",
      deliveries: [
        {
          deliveryId: "legacy-z",
          payload: { event: "legacy" },
          createdAt: "2026-09-01T00:00:00.000Z",
          acknowledgedAt: null,
        },
        {
          deliveryId: "legacy-a",
          payload: { event: "legacy" },
          createdAt: "2026-09-01T00:00:00.000Z",
          acknowledgedAt: null,
        },
      ],
    }),
  );

  await expect(new DeliveryLedger(home).get("owner")).resolves.toMatchObject({
    deliveries: [
      { deliveryId: "legacy-a", messageId: "legacy-a", sequence: 1, status: "recorded" },
      { deliveryId: "legacy-z", messageId: "legacy-z", sequence: 2, status: "recorded" },
    ],
  });
  await expect(
    new DeliveryLedger(home).get("owner", { cursor: "legacy-a" }),
  ).resolves.toMatchObject({
    deliveries: [{ deliveryId: "legacy-z", sequence: 2 }],
  });
  const migrated = JSON.parse(await readFile(deliveryLedgerFilePath(home, "owner"), "utf8")) as {
    version: number;
    nextSequence: number;
  };
  expect(migrated).toMatchObject({ version: 2, nextSequence: 3 });
});

test("acknowledgement is durable and idempotent", async () => {
  const { home, ledger } = await createLedger();
  await ledger.send("owner", { deliveryId: "delivery-one", payload: "hello" });
  await ledger.markDispatching("owner", "delivery-one");
  await ledger.markAccepted("owner", "delivery-one");

  const acknowledged = await ledger.acknowledge("owner", "delivery-one");
  expect(acknowledged.acknowledgedAt).toEqual(expect.any(String));
  await expect(ledger.get("owner")).resolves.toMatchObject({ deliveries: [] });
  await expect(ledger.get("owner", { includeAcknowledged: true })).resolves.toMatchObject({
    deliveries: [acknowledged],
  });

  const recovered = new DeliveryLedger(home);
  await expect(recovered.acknowledge("owner", "delivery-one")).resolves.toEqual(acknowledged);
});

test("acknowledgement only transitions accepted deliveries", async () => {
  const { ledger } = await createLedger();
  for (const [deliveryId, status] of [
    ["recorded-delivery", "recorded"],
    ["dispatching-delivery", "dispatching"],
    ["failed-delivery", "failed"],
    ["ambiguous-delivery", "ambiguous"],
  ] as const) {
    await ledger.send("owner", { deliveryId, payload: deliveryId });
    if (status !== "recorded") {
      if (status === "failed" || status === "ambiguous") {
        await ledger.markDispatching("owner", deliveryId);
      }
      await ledger.transition("owner", deliveryId, status, "test outcome");
    }
    await expect(ledger.acknowledge("owner", deliveryId)).rejects.toMatchObject({
      code: "delivery_transition_invalid",
    });
    await expect(
      ledger.get("owner", { deliveryId, includeAcknowledged: true }),
    ).resolves.toMatchObject({
      delivery: { status, acknowledgedAt: null },
    });
  }

  await ledger.send("owner", { deliveryId: "accepted-delivery", payload: "accepted" });
  await ledger.markDispatching("owner", "accepted-delivery");
  await ledger.markAccepted("owner", "accepted-delivery");
  const acknowledged = await ledger.acknowledge("owner", "accepted-delivery");
  await expect(ledger.acknowledge("owner", "accepted-delivery")).resolves.toEqual(acknowledged);
});

test("an acknowledgement racing dispatch cannot skip native dispatch", async () => {
  const { ledger } = await createLedger();
  await ledger.send("owner", { deliveryId: "racing-delivery", payload: "hello" });

  const [acknowledgement, dispatching] = await Promise.allSettled([
    ledger.acknowledge("owner", "racing-delivery"),
    ledger.markDispatching("owner", "racing-delivery"),
  ]);

  expect(acknowledgement.status).toBe("rejected");
  expect(dispatching).toMatchObject({
    status: "fulfilled",
    value: { status: "dispatching" },
  });
});

test("uses durable owner sequences for same-time concurrent sends and cursors", async () => {
  const { home } = await createLedger();
  const now = new Date("2026-09-02T00:00:00.000Z");
  const sameTime = new DeliveryLedger(home, { now: () => now });
  const results = await Promise.all(
    ["delivery-a", "delivery-b", "delivery-c"].map((deliveryId) =>
      sameTime.send("owner", { deliveryId, payload: deliveryId }),
    ),
  );

  const page = await sameTime.get("owner", { limit: 2 });
  expect(page.deliveries.map((delivery) => delivery.sequence)).toEqual([1, 2]);
  expect(page.deliveries.map((delivery) => delivery.deliveryId)).toEqual(
    results.slice(0, 2).map((result) => result.delivery.deliveryId),
  );
  expect(page.nextCursor).toBe("2");
  await expect(
    sameTime.get("owner", { cursor: page.nextCursor ?? undefined }),
  ).resolves.toMatchObject({
    deliveries: [{ sequence: 3 }],
  });
});

test("acknowledged deliveries no longer consume pending quotas", async () => {
  const { home } = await createLedger();
  const ledger = new DeliveryLedger(home, { maxDeliveries: 1, maxBytes: 128 * 1024 });
  await ledger.send("owner", { deliveryId: "first", payload: "first" });
  await ledger.markDispatching("owner", "first");
  await ledger.markAccepted("owner", "first");
  await ledger.acknowledge("owner", "first");

  await expect(
    ledger.send("owner", { deliveryId: "second", payload: "second" }),
  ).resolves.toMatchObject({ created: true });
});

test("serializes concurrent mutations and makes same-id retries idempotent", async () => {
  const { ledger } = await createLedger();
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      ledger.send("owner", { deliveryId: "delivery-one", payload: { ok: true } }),
    ),
  );

  expect(new Set(results.map((result) => result.delivery.deliveryId))).toEqual(
    new Set(["delivery-one"]),
  );
  expect(results.filter((result) => result.created)).toHaveLength(1);
  await expect(
    ledger.send("owner", { deliveryId: "delivery-one", payload: { ok: false } }),
  ).rejects.toMatchObject<Partial<DeliveryLedgerError>>({ code: "delivery_id_conflict" });
});

test("does not share records between principals", async () => {
  const { ledger } = await createLedger();
  await ledger.send("owner", { deliveryId: "owner-delivery", payload: "owner" });
  await ledger.send("plugin:calendar", { deliveryId: "plugin-delivery", payload: "plugin" });

  await expect(ledger.get("owner")).resolves.toMatchObject({
    deliveries: [expect.objectContaining({ deliveryId: "owner-delivery" })],
  });
  await expect(ledger.get("plugin:calendar")).resolves.toMatchObject({
    deliveries: [expect.objectContaining({ deliveryId: "plugin-delivery" })],
  });
  await expect(ledger.get("owner", { deliveryId: "plugin-delivery" })).resolves.toMatchObject({
    delivery: null,
  });
});

test("writes an atomic owner-specific ledger file", async () => {
  const { home, ledger } = await createLedger();
  await ledger.send("plugin:calendar", { payload: 1 });
  const filePath = deliveryLedgerFilePath(home, "plugin:calendar");
  const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    ownerId: string;
    deliveries: unknown[];
  };
  expect(persisted).toMatchObject({ version: 2, ownerId: "plugin:calendar" });
  expect(persisted.deliveries).toHaveLength(1);
  expect((await stat(filePath)).mode & 0o777).toBe(0o600);
});

test("rejects acknowledgement of an unknown delivery", async () => {
  const { ledger } = await createLedger();
  await expect(ledger.acknowledge("owner", "missing")).rejects.toMatchObject({
    code: "delivery_not_found",
  });
});

test("copies payloads at the persistence boundary", async () => {
  const { ledger } = await createLedger();
  const payload = { nested: { value: "before" } };
  await ledger.send("owner", { deliveryId: "delivery-copy", payload });
  payload.nested.value = "after";

  await expect(ledger.get("owner", { deliveryId: "delivery-copy" })).resolves.toMatchObject({
    delivery: { payload: { nested: { value: "before" } } },
  });
});

test("persists target and message identity and rejects conflicting retries", async () => {
  const { ledger } = await createLedger();
  const input = {
    deliveryId: "delivery-identity",
    targetAgentId: "agent-exact",
    messageId: "message-stable",
    payload: { event: "refresh" },
  };
  const created = await ledger.send("owner", input);
  await expect(ledger.send("owner", input)).resolves.toMatchObject({ created: false });
  await expect(
    ledger.send("owner", { ...input, targetAgentId: "agent-other" }),
  ).rejects.toMatchObject<Partial<DeliveryLedgerError>>({ code: "delivery_id_conflict" });
  await expect(
    ledger.send("owner", { ...input, messageId: "message-other" }),
  ).rejects.toMatchObject<Partial<DeliveryLedgerError>>({ code: "delivery_id_conflict" });
  await expect(
    ledger.send("owner", { deliveryId: input.deliveryId, payload: input.payload }),
  ).rejects.toMatchObject<Partial<DeliveryLedgerError>>({ code: "delivery_id_conflict" });
  expect(created.delivery).toMatchObject({
    targetAgentId: "agent-exact",
    messageId: "message-stable",
    status: "recorded",
  });
});

test("enforces delivery state transitions and keeps terminal retries idempotent", async () => {
  const { ledger } = await createLedger();
  await ledger.send("owner", { deliveryId: "delivery-state", payload: "hello" });

  const dispatching = await ledger.markDispatching("owner", "delivery-state");
  expect(dispatching).toMatchObject({ status: "dispatching", dispatchingAt: expect.any(String) });
  const accepted = await ledger.markAccepted("owner", "delivery-state");
  expect(accepted).toMatchObject({
    status: "accepted",
    acceptedAt: expect.any(String),
    error: null,
  });
  await expect(ledger.markDispatching("owner", "delivery-state")).rejects.toMatchObject({
    code: "delivery_transition_invalid",
  });
  const acknowledged = await ledger.acknowledge("owner", "delivery-state");
  await expect(ledger.acknowledge("owner", "delivery-state")).resolves.toEqual(acknowledged);
});

test("reconciles dispatching records as ambiguous after a ledger restart", async () => {
  const { home, ledger } = await createLedger();
  await ledger.send("owner", {
    deliveryId: "delivery-restart",
    targetAgentId: "agent-exact",
    payload: { event: "refresh" },
  });
  await ledger.markDispatching("owner", "delivery-restart");

  const recovered = new DeliveryLedger(home);
  const result = await recovered.get("owner", { includeAcknowledged: true });
  expect(result.deliveries).toMatchObject([
    {
      deliveryId: "delivery-restart",
      status: "ambiguous",
      targetAgentId: "agent-exact",
      error: expect.stringContaining("restarted"),
    },
  ]);
  await expect(
    recovered.send("owner", {
      deliveryId: "delivery-restart",
      targetAgentId: "agent-exact",
      payload: { event: "refresh" },
    }),
  ).resolves.toMatchObject({ created: false, delivery: { status: "ambiguous" } });
});

test("paginates in creation order while skipping acknowledged rows", async () => {
  const { ledger } = await createLedger();
  for (const deliveryId of ["delivery-a", "delivery-b", "delivery-c"]) {
    await ledger.send("owner", { deliveryId, payload: deliveryId });
  }
  await ledger.markDispatching("owner", "delivery-b");
  await ledger.markAccepted("owner", "delivery-b");
  await ledger.acknowledge("owner", "delivery-b");

  const first = await ledger.get("owner", { limit: 1 });
  expect(first.deliveries.map(({ deliveryId }) => deliveryId)).toEqual(["delivery-a"]);
  expect(first.nextCursor).toBe("1");
  await expect(
    ledger.get("owner", { cursor: first.nextCursor ?? undefined, limit: 1 }),
  ).resolves.toMatchObject({
    deliveries: [{ deliveryId: "delivery-c" }],
    nextCursor: null,
  });
  await expect(ledger.get("owner", { cursor: "missing" })).rejects.toMatchObject({
    code: "delivery_cursor_invalid",
  });
  await expect(ledger.get("owner", { includeAcknowledged: true })).resolves.toMatchObject({
    deliveries: [
      { deliveryId: "delivery-a" },
      { deliveryId: "delivery-b", status: "acknowledged" },
      { deliveryId: "delivery-c" },
    ],
  });
});

test("enforces record, byte, payload, and owner validation limits", async () => {
  const { home } = await createLedger();
  const limited = new DeliveryLedger(home, { maxDeliveries: 1, maxPayloadBytes: 8 });
  await limited.send("owner", { deliveryId: "delivery-one", payload: "ok" });
  await expect(
    limited.send("owner", { deliveryId: "delivery-two", payload: "ok" }),
  ).rejects.toMatchObject({
    code: "delivery_quota_exceeded",
  });
  await expect(
    limited.send("owner", { deliveryId: "delivery-large", payload: "too-large" }),
  ).rejects.toMatchObject({ code: "delivery_payload_too_large" });
  await expect(
    limited.send("owner", { deliveryId: "delivery-invalid", payload: undefined as never }),
  ).rejects.toMatchObject({ code: "delivery_payload_invalid" });
  expect(() => deliveryLedgerFilePath(home, " ../escape")).toThrow(DeliveryLedgerError);
});

test("confines root and ledger loads and repairs permissions", async () => {
  const { home, ledger } = await createLedger();
  await ledger.send("owner", { deliveryId: "secure-delivery", payload: "secure" });
  const filePath = deliveryLedgerFilePath(home, "owner");
  await chmod(home, 0o755);
  await chmod(filePath, 0o644);

  await expect(new DeliveryLedger(home).get("owner")).resolves.toMatchObject({
    deliveries: [{ deliveryId: "secure-delivery" }],
  });
  expect((await lstat(home)).mode & 0o7777).toBe(0o700);
  expect((await lstat(filePath)).mode & 0o7777).toBe(0o600);

  const realFile = path.join(home, "real-owner.json");
  await rename(filePath, realFile);
  await symlink(realFile, filePath);
  await expect(new DeliveryLedger(home).get("owner")).rejects.toMatchObject({
    code: "delivery_ledger_unavailable",
  });
  await unlink(filePath);
  await rename(realFile, filePath);

  const realRoot = path.join(home, "real-root");
  const linkedRoot = path.join(home, "linked-root");
  await mkdir(realRoot);
  await symlink(realRoot, linkedRoot);
  await expect(new DeliveryLedger(linkedRoot).get("owner")).rejects.toMatchObject({
    code: "delivery_ledger_unavailable",
  });
});

test("quarantines malformed ledgers and removeOwner purges every copy", async () => {
  const { home } = await createLedger();
  const filePath = deliveryLedgerFilePath(home, "owner");
  await writeFile(filePath, "{malformed", { mode: 0o600 });
  const diagnostics: string[] = [];
  const ledger = new DeliveryLedger(home, {
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.quarantinePath),
  });

  await expect(ledger.get("owner")).resolves.toMatchObject({ deliveries: [] });
  expect(diagnostics).toHaveLength(1);
  expect(await readdir(home)).toContain(path.basename(diagnostics[0] ?? ""));
  await expect(
    ledger.send("owner", { deliveryId: "fresh-delivery", payload: "fresh" }),
  ).resolves.toMatchObject({ created: true });

  await ledger.removeOwner("owner");
  expect(await readdir(home)).not.toEqual(
    expect.arrayContaining([path.basename(filePath), path.basename(diagnostics[0] ?? "")]),
  );
});

test("GC compacts acknowledged payloads but retains fingerprints and unacknowledged rows", async () => {
  let now = new Date("2026-09-02T00:00:00.000Z");
  const { home } = await createLedger();
  const configured = new DeliveryLedger(home, {
    now: () => now,
    maxAcknowledgedPayloads: 1,
    maxAcknowledgedPayloadBytes: 1024 * 1024,
    acknowledgedPayloadMaxAgeMs: 100_000,
    tombstoneRetentionMs: 1_000,
  });
  for (const deliveryId of ["gc-a", "gc-b", "gc-c"]) {
    await configured.send("owner", { deliveryId, payload: { deliveryId } });
    await configured.markDispatching("owner", deliveryId);
    await configured.markAccepted("owner", deliveryId);
    await configured.acknowledge("owner", deliveryId);
  }
  await configured.send("owner", { deliveryId: "gc-pending", payload: "keep" });

  const compacted = await configured.get("owner", { includeAcknowledged: true });
  expect(compacted.deliveries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ deliveryId: "gc-a", payloadFingerprint: expect.any(String) }),
      expect.objectContaining({ deliveryId: "gc-b", payloadFingerprint: expect.any(String) }),
      expect.objectContaining({ deliveryId: "gc-c", payload: { deliveryId: "gc-c" } }),
      expect.objectContaining({ deliveryId: "gc-pending", payload: "keep", status: "recorded" }),
    ]),
  );
  expect(compacted.deliveries.find(({ deliveryId }) => deliveryId === "gc-a")).not.toHaveProperty(
    "payload",
  );
  const beforeGc = await configured.get("owner", { includeAcknowledged: true, limit: 3 });
  expect(beforeGc.nextCursor).toBe("3");

  now = new Date("2026-09-02T00:00:02.000Z");
  await configured.gc("owner");
  const afterRetention = await configured.get("owner", { includeAcknowledged: true });
  expect(afterRetention.deliveries.map(({ deliveryId }) => deliveryId)).toEqual(["gc-pending"]);
  await expect(
    configured.get("owner", {
      includeAcknowledged: true,
      cursor: beforeGc.nextCursor ?? undefined,
    }),
  ).resolves.toMatchObject({ deliveries: [{ deliveryId: "gc-pending", sequence: 4 }] });
});

test("pages by exact encoded response budget and rejects an item that cannot fit", async () => {
  const { ledger } = await createLedger();
  await ledger.send("owner", { deliveryId: "budget-a", payload: "a".repeat(2_000) });
  await ledger.send("owner", { deliveryId: "budget-b", payload: "b".repeat(2_000) });
  const page = await ledger.get("owner", {
    responseRequestId: "budget-request",
    maxEncodedBytes: 2_500,
  });
  const encoded = JSON.stringify({
    type: "session",
    message: { type: "deliveries.get.response", payload: { requestId: "budget-request", ...page } },
  });
  expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(2_500);
  expect(page.deliveries).toHaveLength(1);
  await expect(
    ledger.get("owner", { responseRequestId: "budget-request", maxEncodedBytes: 100 }),
  ).rejects.toMatchObject({ code: "delivery_response_too_large" });
});

test("purges one principal without affecting another", async () => {
  const { home, ledger } = await createLedger();
  await ledger.send("owner", { deliveryId: "owner-delivery", payload: "owner" });
  await ledger.send("plugin:one:installation", {
    deliveryId: "plugin-delivery",
    payload: "plugin",
  });
  await ledger.removeOwner("plugin:one:installation");

  await expect(ledger.get("plugin:one:installation")).resolves.toMatchObject({ deliveries: [] });
  await expect(ledger.get("owner")).resolves.toMatchObject({
    deliveries: [{ deliveryId: "owner-delivery" }],
  });
  await expect(new DeliveryLedger(home).get("plugin:one:installation")).resolves.toMatchObject({
    deliveries: [],
  });
});

test("shares one in-flight dispatch per key", async () => {
  const coordinator = new DeliveryDispatchCoordinator();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const operation = async () => {
    calls += 1;
    await gate;
    return "accepted";
  };

  const first = coordinator.run("owner:delivery", operation);
  const second = coordinator.run("owner:delivery", operation);
  expect(first).toBe(second);
  expect(calls).toBe(0);
  release();
  await expect(Promise.all([first, second])).resolves.toEqual(["accepted", "accepted"]);
  expect(calls).toBe(1);
  await expect(coordinator.run("owner:delivery", operation)).resolves.toBe("accepted");
  expect(calls).toBe(2);
});

test("fences new dispatches while an owner is being removed", async () => {
  const coordinator = new DeliveryDispatchCoordinator();
  let release!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatch = coordinator.run("owner:delivery", () => inFlight, "owner");
  coordinator.beginOwnerClosing("owner");
  await expect(coordinator.run("owner:other", async () => "late", "owner")).rejects.toMatchObject({
    code: "delivery_owner_closing",
  });
  await expect(coordinator.waitForOwner("owner", 1)).resolves.toBe(false);
  release();
  await dispatch;
  await expect(coordinator.waitForOwner("owner", 1)).resolves.toBe(true);
  coordinator.finishOwner("owner");
  await expect(coordinator.run("owner:other", async () => "after", "owner")).resolves.toBe("after");
});
