import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { DeliveryLedger, DeliveryLedgerError, deliveryLedgerFilePath } from "./delivery-ledger.js";

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
});

test("rejects acknowledgement of an unknown delivery", async () => {
  const { ledger } = await createLedger();
  await expect(ledger.acknowledge("owner", "missing")).rejects.toMatchObject({
    code: "delivery_not_found",
  });
});
