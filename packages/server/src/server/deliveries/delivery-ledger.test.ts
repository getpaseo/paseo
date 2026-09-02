import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
          deliveryId: "legacy-delivery",
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
        deliveryId: "legacy-delivery",
        messageId: "legacy-delivery",
        status: "recorded",
      },
    ],
  });
});

test("acknowledgement is durable and idempotent", async () => {
  const { home, ledger } = await createLedger();
  await ledger.send("owner", { deliveryId: "delivery-one", payload: "hello" });

  const acknowledged = await ledger.acknowledge("owner", "delivery-one");
  expect(acknowledged.acknowledgedAt).toEqual(expect.any(String));
  await expect(ledger.get("owner")).resolves.toMatchObject({ deliveries: [] });
  await expect(ledger.get("owner", { includeAcknowledged: true })).resolves.toMatchObject({
    deliveries: [acknowledged],
  });

  const recovered = new DeliveryLedger(home);
  await expect(recovered.acknowledge("owner", "delivery-one")).resolves.toEqual(acknowledged);
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
  expect(persisted).toMatchObject({ version: 1, ownerId: "plugin:calendar" });
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
  await ledger.acknowledge("owner", "delivery-b");

  const first = await ledger.get("owner", { limit: 1 });
  expect(first.deliveries.map(({ deliveryId }) => deliveryId)).toEqual(["delivery-a"]);
  expect(first.nextCursor).toBe("delivery-a");
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
