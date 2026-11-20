import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createJsonFinishSubscriptionStore } from "../index.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function temporaryHome() {
  const result = await mkdtemp(join(tmpdir(), "finish-subscriptions-"));
  homes.push(result);
  return result;
}
const subscription = {
  id: "subscription",
  callerAgentId: "parent",
  childAgentId: "child",
  serverId: "remote",
};

test("acknowledged concurrent writes survive reopening and removal", async () => {
  const directory = await temporaryHome();
  const store = createJsonFinishSubscriptionStore(directory);
  await Promise.all([store.put(subscription), store.put({ ...subscription, id: "second" })]);
  const restarted = createJsonFinishSubscriptionStore(directory);
  expect(await restarted.list()).toEqual([subscription, { ...subscription, id: "second" }]);
  await restarted.remove(subscription.id);
  expect(await createJsonFinishSubscriptionStore(directory).list()).toEqual([
    { ...subscription, id: "second" },
  ]);
});

test("write failure rejects registration and does not publish an unwritten record", async () => {
  const directory = await temporaryHome();
  const store = createJsonFinishSubscriptionStore(directory);
  expect(await store.list()).toEqual([]);
  await mkdir(join(directory, "finish-subscriptions.json"));
  await expect(store.put(subscription)).rejects.toThrow();
  expect(await store.list()).toEqual([]);
});

test("invalid persisted records fail visibly", async () => {
  const directory = await temporaryHome();
  await writeFile(
    join(directory, "finish-subscriptions.json"),
    JSON.stringify([{ callerAgentId: 42 }]),
  );
  await expect(createJsonFinishSubscriptionStore(directory).list()).rejects.toThrow();
});

test("notification event selection round-trips beside legacy records without it", async () => {
  const directory = await temporaryHome();
  const selective = { ...subscription, notifyOn: ["finished" as const, "errored" as const] };
  // Records written before notifyOn existed have no such field.
  await writeFile(
    join(directory, "finish-subscriptions.json"),
    JSON.stringify([{ ...subscription, id: "legacy" }]),
  );
  await createJsonFinishSubscriptionStore(directory).put(selective);
  expect(await createJsonFinishSubscriptionStore(directory).list()).toEqual([
    { ...subscription, id: "legacy" },
    selective,
  ]);
});

test("an empty notification event selection fails visibly", async () => {
  const directory = await temporaryHome();
  await writeFile(
    join(directory, "finish-subscriptions.json"),
    JSON.stringify([{ ...subscription, notifyOn: [] }]),
  );
  await expect(createJsonFinishSubscriptionStore(directory).list()).rejects.toThrow();
});
