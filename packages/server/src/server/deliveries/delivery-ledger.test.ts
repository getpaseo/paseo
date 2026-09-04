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
    targetAgentId: "agent-test",
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
      {
        deliveryId: "legacy-a",
        messageId: "legacy-a",
        sequence: 1,
        status: "accepted",
        deliveryMode: "legacy_pull",
      },
      {
        deliveryId: "legacy-z",
        messageId: "legacy-z",
        sequence: 2,
        status: "accepted",
        deliveryMode: "legacy_pull",
      },
    ],
  });
  await expect(new DeliveryLedger(home).get("owner", { cursor: "seq:1" })).resolves.toMatchObject({
    deliveries: [{ deliveryId: "legacy-z", sequence: 2 }],
  });
  const consumer = new DeliveryLedger(home);
  await expect(consumer.acknowledge("owner", "legacy-a")).resolves.toMatchObject({
    deliveryId: "legacy-a",
    deliveryMode: "legacy_pull",
    status: "acknowledged",
  });
  const migrated = JSON.parse(await readFile(deliveryLedgerFilePath(home, "owner"), "utf8")) as {
    version: number;
    nextSequence: number;
  };
  expect(migrated).toMatchObject({ version: 2, nextSequence: 3 });
});

test("acknowledgement is durable and idempotent", async () => {
  const { home, ledger } = await createLedger();
  await ledger.send("owner", {
    deliveryId: "delivery-one",
    targetAgentId: "agent-test",
    payload: "hello",
  });
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

test("filters and acknowledges only the exact authorized delivery target", async () => {
  const { ledger } = await createLedger();
  await ledger.send("owner", {
    deliveryId: "agent-one-delivery",
    targetAgentId: "agent-one",
    payload: { agent: "one" },
  });
  await ledger.send("owner", {
    deliveryId: "agent-two-delivery",
    targetAgentId: "agent-two",
    payload: { agent: "two" },
  });
  await ledger.markDispatching("owner", "agent-one-delivery");
  await ledger.markAccepted("owner", "agent-one-delivery");

  await expect(ledger.get("owner", { targetAgentId: "agent-one" })).resolves.toMatchObject({
    deliveries: [{ deliveryId: "agent-one-delivery" }],
  });
  await expect(
    ledger.get("owner", { deliveryId: "agent-two-delivery", targetAgentId: "agent-one" }),
  ).resolves.toMatchObject({ delivery: null, deliveries: [] });
  await expect(
    ledger.acknowledge("owner", "agent-two-delivery", { targetAgentId: "agent-one" }),
  ).rejects.toMatchObject({ code: "delivery_target_mismatch" });
  await expect(
    ledger.acknowledge("owner", "agent-one-delivery", { targetAgentId: "agent-one" }),
  ).resolves.toMatchObject({
    status: "acknowledged",
  });
});

test("acknowledgement only transitions accepted deliveries", async () => {
  const { ledger } = await createLedger();
  for (const [deliveryId, status] of [
    ["recorded-delivery", "recorded"],
    ["dispatching-delivery", "dispatching"],
    ["failed-delivery", "failed"],
    ["ambiguous-delivery", "ambiguous"],
  ] as const) {
    await ledger.send("owner", { deliveryId, targetAgentId: "agent-test", payload: deliveryId });
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

  await ledger.send("owner", {
    deliveryId: "accepted-delivery",
    targetAgentId: "agent-test",
    payload: "accepted",
  });
  await ledger.markDispatching("owner", "accepted-delivery");
  await ledger.markAccepted("owner", "accepted-delivery");
  const acknowledged = await ledger.acknowledge("owner", "accepted-delivery");
  await expect(ledger.acknowledge("owner", "accepted-delivery")).resolves.toEqual(acknowledged);
});

test("an acknowledgement racing dispatch cannot skip native dispatch", async () => {
  const { ledger } = await createLedger();
  await ledger.send("owner", {
    deliveryId: "racing-delivery",
    targetAgentId: "agent-test",
    payload: "hello",
  });

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
    ["delivery-a", "delivery-b", "delivery-c", "delivery-d"].map((deliveryId) =>
      sameTime.send("owner", { deliveryId, targetAgentId: "agent-test", payload: deliveryId }),
    ),
  );

  const page = await sameTime.get("owner", { limit: 2 });
  expect(page.deliveries.map((delivery) => delivery.sequence)).toEqual([1, 2]);
  expect(page.deliveries.map((delivery) => delivery.deliveryId)).toEqual(
    results.slice(0, 2).map((result) => result.delivery.deliveryId),
  );
  expect(page.nextCursor).toBe("seq:2");
  const nextPage = await sameTime.get("owner", {
    cursor: page.nextCursor ?? undefined,
    limit: 1,
  });
  expect(nextPage).toMatchObject({ deliveries: [{ sequence: 3 }], nextCursor: "seq:3" });
  expect(nextPage.nextCursor).not.toBe(page.nextCursor);
  await expect(
    sameTime.get("owner", { cursor: nextPage.nextCursor ?? undefined }),
  ).resolves.toMatchObject({ deliveries: [{ sequence: 4 }] });
});

test("accepts a legacy numeric sequence cursor without resolving it as a delivery ID", async () => {
  const { ledger } = await createLedger();
  await ledger.send("owner", { deliveryId: "2", targetAgentId: "agent-test", payload: "first" });
  await ledger.send("owner", {
    deliveryId: "after-numeric-id",
    targetAgentId: "agent-test",
    payload: "second",
  });

  await expect(ledger.get("owner", { cursor: "1" })).resolves.toMatchObject({
    deliveries: [{ deliveryId: "after-numeric-id", sequence: 2 }],
  });
  await expect(ledger.get("owner", { cursor: "seq:1" })).resolves.toMatchObject({
    deliveries: [{ deliveryId: "after-numeric-id", sequence: 2 }],
  });
});

test("treats a seq cursor as a sequence even when a delivery ID collides with it", async () => {
  const { ledger } = await createLedger();
  await ledger.send("owner", {
    deliveryId: "first-delivery",
    targetAgentId: "agent-test",
    payload: "first",
  });
  await ledger.send("owner", {
    deliveryId: "seq:1",
    targetAgentId: "agent-test",
    payload: "second",
  });

  await expect(ledger.get("owner", { cursor: "seq:1" })).resolves.toMatchObject({
    deliveries: [{ deliveryId: "seq:1", sequence: 2 }],
  });
  await expect(ledger.get("owner", { deliveryId: "seq:1" })).resolves.toMatchObject({
    delivery: { deliveryId: "seq:1", sequence: 2 },
  });
});

test("never resolves an arbitrary delivery ID supplied in the cursor field", async () => {
  const { ledger } = await createLedger();
  await ledger.send("owner", {
    deliveryId: "delivery-cursor-id",
    targetAgentId: "agent-test",
    payload: "payload",
  });

  await expect(ledger.get("owner", { cursor: "delivery-cursor-id" })).rejects.toMatchObject({
    code: "delivery_cursor_invalid",
  });
});

test("acknowledged deliveries no longer consume pending quotas", async () => {
  const { home } = await createLedger();
  const ledger = new DeliveryLedger(home, { maxDeliveries: 1, maxBytes: 128 * 1024 });
  await ledger.send("owner", {
    deliveryId: "first",
    targetAgentId: "agent-test",
    payload: "first",
  });
  await ledger.markDispatching("owner", "first");
  await ledger.markAccepted("owner", "first");
  await ledger.acknowledge("owner", "first");

  await expect(
    ledger.send("owner", {
      deliveryId: "second",
      targetAgentId: "agent-test",
      payload: "second",
    }),
  ).resolves.toMatchObject({ created: true });
});

test("serializes concurrent mutations and makes same-id retries idempotent", async () => {
  const { ledger } = await createLedger();
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      ledger.send("owner", {
        deliveryId: "delivery-one",
        targetAgentId: "agent-test",
        payload: { ok: true },
      }),
    ),
  );

  expect(new Set(results.map((result) => result.delivery.deliveryId))).toEqual(
    new Set(["delivery-one"]),
  );
  expect(results.filter((result) => result.created)).toHaveLength(1);
  await expect(
    ledger.send("owner", {
      deliveryId: "delivery-one",
      targetAgentId: "agent-test",
      payload: { ok: false },
    }),
  ).rejects.toMatchObject<Partial<DeliveryLedgerError>>({ code: "delivery_id_conflict" });
});

test("does not share records between principals", async () => {
  const { ledger } = await createLedger();
  await ledger.send("owner", {
    deliveryId: "owner-delivery",
    targetAgentId: "agent-test",
    payload: "owner",
  });
  await ledger.send("plugin:calendar", {
    deliveryId: "plugin-delivery",
    targetAgentId: "agent-test",
    payload: "plugin",
  });

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
  await ledger.send("plugin:calendar", { targetAgentId: "agent-test", payload: 1 });
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
  await ledger.send("owner", {
    deliveryId: "delivery-copy",
    targetAgentId: "agent-test",
    payload,
  });
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

test("accepts targetless old-wire sends as durable acknowledged legacy pulls", async () => {
  const { home, ledger } = await createLedger();
  const result = await ledger.send("owner", {
    deliveryId: "legacy-send",
    payload: { event: "refresh" },
  });

  expect(result).toMatchObject({
    created: true,
    delivery: {
      deliveryId: "legacy-send",
      messageId: "legacy-send",
      deliveryMode: "legacy_pull",
      status: "accepted",
      acceptedAt: expect.any(String),
      acknowledgedAt: null,
    },
  });
  expect(result.delivery).not.toHaveProperty("targetAgentId");
  await expect(
    ledger.send("owner", {
      deliveryId: "legacy-send",
      payload: { event: "refresh" },
    }),
  ).resolves.toMatchObject({ created: false, delivery: result.delivery });

  const recovered = new DeliveryLedger(home);
  await expect(recovered.get("owner")).resolves.toMatchObject({
    deliveries: [
      {
        deliveryId: "legacy-send",
        deliveryMode: "legacy_pull",
        status: "accepted",
      },
    ],
  });
  await expect(recovered.acknowledge("owner", "legacy-send")).resolves.toMatchObject({
    deliveryId: "legacy-send",
    deliveryMode: "legacy_pull",
    status: "acknowledged",
  });
});

test("enforces delivery state transitions and keeps terminal retries idempotent", async () => {
  const { ledger } = await createLedger();
  await ledger.send("owner", {
    deliveryId: "delivery-state",
    targetAgentId: "agent-test",
    payload: "hello",
  });

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
    await ledger.send("owner", { deliveryId, targetAgentId: "agent-test", payload: deliveryId });
  }
  await ledger.markDispatching("owner", "delivery-b");
  await ledger.markAccepted("owner", "delivery-b");
  await ledger.acknowledge("owner", "delivery-b");

  const first = await ledger.get("owner", { limit: 1 });
  expect(first.deliveries.map(({ deliveryId }) => deliveryId)).toEqual(["delivery-a"]);
  expect(first.nextCursor).toBe("seq:1");
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
  await limited.send("owner", {
    deliveryId: "delivery-one",
    targetAgentId: "agent-test",
    payload: "ok",
  });
  await expect(
    limited.send("owner", {
      deliveryId: "delivery-two",
      targetAgentId: "agent-test",
      payload: "ok",
    }),
  ).rejects.toMatchObject({
    code: "delivery_quota_exceeded",
  });
  await expect(
    limited.send("owner", {
      deliveryId: "delivery-large",
      targetAgentId: "agent-test",
      payload: "too-large",
    }),
  ).rejects.toMatchObject({ code: "delivery_payload_too_large" });
  await expect(
    limited.send("owner", {
      deliveryId: "delivery-invalid",
      targetAgentId: "agent-test",
      payload: undefined as never,
    }),
  ).rejects.toMatchObject({ code: "delivery_payload_invalid" });
  expect(() => deliveryLedgerFilePath(home, " ../escape")).toThrow(DeliveryLedgerError);
});

test("quarantines loaded pending records without payload or with a mismatched fingerprint", async () => {
  const { home } = await createLedger();
  const filePath = deliveryLedgerFilePath(home, "owner");
  const diagnostics: string[] = [];
  await writeFile(
    filePath,
    JSON.stringify({
      version: 2,
      ownerId: "owner",
      nextSequence: 2,
      deliveries: [
        {
          deliveryId: "missing-payload",
          sequence: 1,
          targetAgentId: "agent-test",
          messageId: "missing-payload",
          status: "accepted",
          payloadFingerprint: "a".repeat(64),
          createdAt: "2026-09-01T00:00:00.000Z",
          acknowledgedAt: null,
        },
      ],
    }),
  );
  const ledger = new DeliveryLedger(home, {
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.quarantinePath),
  });

  await expect(ledger.get("owner")).resolves.toMatchObject({ deliveries: [] });
  expect(diagnostics).toHaveLength(1);
  expect(await readdir(home)).toContain(path.basename(diagnostics[0] ?? ""));
});

test("quarantines a loaded record whose payload fingerprint was changed", async () => {
  const { home } = await createLedger();
  const filePath = deliveryLedgerFilePath(home, "owner");
  await writeFile(
    filePath,
    JSON.stringify({
      version: 2,
      ownerId: "owner",
      nextSequence: 2,
      deliveries: [
        {
          deliveryId: "mismatched-fingerprint",
          sequence: 1,
          targetAgentId: "agent-test",
          status: "recorded",
          payload: "actual",
          payloadFingerprint: "0".repeat(64),
          createdAt: "2026-09-01T00:00:00.000Z",
          acknowledgedAt: null,
        },
      ],
    }),
  );
  const diagnostics: string[] = [];
  const ledger = new DeliveryLedger(home, {
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.quarantinePath),
  });

  await expect(ledger.get("owner")).resolves.toMatchObject({ deliveries: [] });
  expect(diagnostics).toHaveLength(1);
});

test("quarantines a loaded pending record without a target", async () => {
  const { home } = await createLedger();
  const filePath = deliveryLedgerFilePath(home, "owner");
  await writeFile(
    filePath,
    JSON.stringify({
      version: 2,
      ownerId: "owner",
      nextSequence: 2,
      deliveries: [
        {
          deliveryId: "missing-target",
          sequence: 1,
          status: "recorded",
          payload: "payload",
          createdAt: "2026-09-01T00:00:00.000Z",
          acknowledgedAt: null,
        },
      ],
    }),
  );
  const diagnostics: string[] = [];
  const ledger = new DeliveryLedger(home, {
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.quarantinePath),
  });

  await expect(ledger.get("owner")).resolves.toMatchObject({ deliveries: [] });
  expect(diagnostics).toHaveLength(1);
});

test.each(["dangerous payload keys", "excessive payload depth"])(
  "quarantines loaded records with %s",
  async (caseName) => {
    const { home } = await createLedger();
    const filePath = deliveryLedgerFilePath(home, "owner");
    const payload =
      caseName === "dangerous payload keys"
        ? JSON.parse('{"__proto__":"unsafe"}')
        : (() => {
            let nested: unknown = true;
            for (let index = 0; index <= 32; index += 1) nested = { nested };
            return nested;
          })();
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        ownerId: "owner",
        nextSequence: 2,
        deliveries: [
          {
            deliveryId: "invalid-payload",
            sequence: 1,
            targetAgentId: "agent-test",
            status: "recorded",
            payload,
            createdAt: "2026-09-01T00:00:00.000Z",
            acknowledgedAt: null,
          },
        ],
      }),
    );
    const diagnostics: string[] = [];
    const ledger = new DeliveryLedger(home, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.quarantinePath),
    });

    await expect(ledger.get("owner")).resolves.toMatchObject({ deliveries: [] });
    expect(diagnostics).toHaveLength(1);
    expect(await readdir(home)).toContain(path.basename(diagnostics[0] ?? ""));
  },
);

test("confines root and ledger loads and repairs permissions", async () => {
  const { home, ledger } = await createLedger();
  await ledger.send("owner", {
    deliveryId: "secure-delivery",
    targetAgentId: "agent-test",
    payload: "secure",
  });
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
    ledger.send("owner", {
      deliveryId: "fresh-delivery",
      targetAgentId: "agent-test",
      payload: "fresh",
    }),
  ).resolves.toMatchObject({ created: true });

  await ledger.removeOwner("owner");
  expect(await readdir(home)).not.toEqual(
    expect.arrayContaining([path.basename(filePath), path.basename(diagnostics[0] ?? "")]),
  );
  expect(ledger.isOwnerClosing("owner")).toBe(true);
  await expect(
    ledger.send("owner", {
      deliveryId: "late-delivery",
      targetAgentId: "agent-test",
      payload: "late",
    }),
  ).rejects.toMatchObject({ code: "delivery_owner_closing" });
});

test("flush tolerates a rejected historical load and removeOwner clears it", async () => {
  const { home, ledger } = await createLedger();
  const filePath = deliveryLedgerFilePath(home, "owner");
  const realFile = path.join(home, "real-owner.json");
  await writeFile(realFile, "{malformed", { mode: 0o600 });
  await symlink(realFile, filePath);

  await expect(ledger.get("owner")).rejects.toMatchObject({
    code: "delivery_ledger_unavailable",
  });
  await expect(ledger.flush()).resolves.toBeUndefined();
  await expect(ledger.removeOwner("owner")).resolves.toBeUndefined();
  await expect(ledger.flush()).resolves.toBeUndefined();
  expect(ledger.isOwnerClosing("owner")).toBe(true);
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
    await configured.send("owner", {
      deliveryId,
      targetAgentId: "agent-test",
      payload: { deliveryId },
      payloadTombstoneEligible: true,
    });
    await configured.markDispatching("owner", deliveryId);
    await configured.markAccepted("owner", deliveryId);
    await configured.acknowledge("owner", deliveryId);
  }
  await configured.send("owner", {
    deliveryId: "gc-pending",
    targetAgentId: "agent-test",
    payload: "keep",
  });

  const compacted = await configured.get("owner", {
    includeAcknowledged: true,
    allowPayloadTombstones: true,
  });
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
  const beforeGc = await configured.get("owner", {
    includeAcknowledged: true,
    allowPayloadTombstones: true,
    limit: 3,
  });
  expect(beforeGc.nextCursor).toBe("seq:3");

  now = new Date("2026-09-02T00:00:02.000Z");
  await configured.gc("owner");
  const afterRetention = await configured.get("owner", {
    includeAcknowledged: true,
    allowPayloadTombstones: true,
  });
  expect(afterRetention.deliveries.map(({ deliveryId }) => deliveryId)).toEqual(["gc-pending"]);
  await expect(
    configured.get("owner", {
      includeAcknowledged: true,
      cursor: beforeGc.nextCursor ?? undefined,
    }),
  ).resolves.toMatchObject({ deliveries: [{ deliveryId: "gc-pending", sequence: 4 }] });
});

test("only capable clients admit payload tombstones and older clients get truthful rows", async () => {
  const { home } = await createLedger();
  const configured = new DeliveryLedger(home, {
    maxAcknowledgedPayloads: 0,
    maxAcknowledgedPayloadBytes: 0,
    acknowledgedPayloadMaxAgeMs: 100_000,
    tombstoneRetentionMs: 100_000,
  });
  await configured.send("owner", {
    deliveryId: "old-client-delivery",
    targetAgentId: "agent-test",
    payload: "kept",
  });
  await configured.markDispatching("owner", "old-client-delivery");
  await configured.markAccepted("owner", "old-client-delivery");
  await configured.acknowledge("owner", "old-client-delivery");
  await configured.gc("owner", true);

  await configured.send("owner", {
    deliveryId: "capable-client-delivery",
    targetAgentId: "agent-test",
    payload: "compacted",
    payloadTombstoneEligible: true,
  });
  await configured.markDispatching("owner", "capable-client-delivery");
  await configured.markAccepted("owner", "capable-client-delivery");
  const firstTombstoneAcknowledgement = await configured.acknowledge(
    "owner",
    "capable-client-delivery",
    {
      allowPayloadTombstones: true,
    },
  );
  const repeatedTombstoneAcknowledgement = await configured.acknowledge(
    "owner",
    "capable-client-delivery",
    {
      allowPayloadTombstones: true,
    },
  );
  expect(repeatedTombstoneAcknowledgement).toMatchObject({
    deliveryId: firstTombstoneAcknowledgement.deliveryId,
    status: "acknowledged",
    acknowledgedAt: firstTombstoneAcknowledgement.acknowledgedAt,
    payloadFingerprint: firstTombstoneAcknowledgement.payloadFingerprint,
  });
  expect(repeatedTombstoneAcknowledgement).not.toHaveProperty("payload");

  await expect(configured.get("owner", { includeAcknowledged: true })).resolves.toMatchObject({
    deliveries: [{ deliveryId: "old-client-delivery", payload: "kept" }],
  });
  await expect(
    configured.get("owner", { includeAcknowledged: true, allowPayloadTombstones: true }),
  ).resolves.toMatchObject({
    deliveries: [
      { deliveryId: "old-client-delivery", payload: "kept" },
      { deliveryId: "capable-client-delivery", payloadFingerprint: expect.any(String) },
    ],
  });
  await expect(
    configured.get("owner", {
      deliveryId: "capable-client-delivery",
      includeAcknowledged: true,
    }),
  ).resolves.toMatchObject({ delivery: null });
  await expect(configured.acknowledge("owner", "capable-client-delivery")).rejects.toMatchObject({
    code: "delivery_payload_unavailable",
  });

  const persistedBeforeResend = JSON.parse(
    await readFile(deliveryLedgerFilePath(home, "owner"), "utf8"),
  ) as { deliveries: Array<Record<string, unknown>> };
  expect(
    persistedBeforeResend.deliveries.find(
      ({ deliveryId }) => deliveryId === "capable-client-delivery",
    ),
  ).not.toHaveProperty("payload");

  await expect(
    configured.send("owner", {
      deliveryId: "capable-client-delivery",
      targetAgentId: "agent-test",
      payload: "compacted",
    }),
  ).resolves.toMatchObject({
    created: false,
    delivery: { deliveryId: "capable-client-delivery", payload: "compacted" },
  });

  const persistedAfterResend = JSON.parse(
    await readFile(deliveryLedgerFilePath(home, "owner"), "utf8"),
  ) as { deliveries: Array<Record<string, unknown>> };
  expect(
    persistedAfterResend.deliveries.find(
      ({ deliveryId }) => deliveryId === "capable-client-delivery",
    ),
  ).not.toHaveProperty("payload");
});

test("pages by exact encoded response budget and rejects an item that cannot fit", async () => {
  const { ledger } = await createLedger();
  await ledger.send("owner", {
    deliveryId: "budget-a",
    targetAgentId: "agent-test",
    payload: "a".repeat(2_000),
  });
  await ledger.send("owner", {
    deliveryId: "budget-b",
    targetAgentId: "agent-test",
    payload: "b".repeat(2_000),
  });
  const page = await ledger.get("owner", {
    responseRequestId: "budget-request",
    maxEncodedBytes: 3_500,
  });
  const encoded = JSON.stringify({
    type: "session",
    message: { type: "deliveries.get.response", payload: { requestId: "budget-request", ...page } },
  });
  expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(3_500);
  expect(page.deliveries).toHaveLength(1);
  await expect(
    ledger.get("owner", { responseRequestId: "budget-request", maxEncodedBytes: 100 }),
  ).rejects.toMatchObject({ code: "delivery_response_too_large" });
});

test("purges one principal without affecting another", async () => {
  const { home, ledger } = await createLedger();
  await ledger.send("owner", {
    deliveryId: "owner-delivery",
    targetAgentId: "agent-test",
    payload: "owner",
  });
  await ledger.send("plugin:one:installation", {
    deliveryId: "plugin-delivery",
    targetAgentId: "agent-test",
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
  await expect(coordinator.run("owner:other", async () => "after", "owner")).rejects.toMatchObject({
    code: "delivery_owner_closing",
  });
});
