import { defineSubscription } from "@getpaseo/plugin";
import { subscribePluginRpc } from "@getpaseo/plugin/client/host";
import type { PluginSubscriptionContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { expect, test } from "vitest";
import { z } from "zod";
import type { PluginProcessMessage } from "./plugin-process-protocol.js";
import { PluginSubscriptionHandlers } from "./subscription-handlers.js";

const lengths = defineSubscription({
  name: "lengths",
  input: z.object({ times: z.string().transform(Number) }),
  event: z.string().transform((text) => text.length),
});

/** The plugin process's handlers wired to the client helper through the channel between them. */
function connect(handler: (input: unknown, context: PluginSubscriptionContext) => unknown) {
  const handlers = new PluginSubscriptionHandlers({
    send: (message) => deliver(message),
    sendAndWait: async (message) => deliver(message),
  });
  handlers.register(lengths, handler);
  let observer: Parameters<Parameters<typeof subscribePluginRpc>[1]>[2] | null = null;
  function deliver(message: PluginProcessMessage) {
    if (message.type === "subscription.event") observer?.event(message.event);
    if (message.type === "subscription.closed") observer?.closed();
  }
  return (method: string, input: unknown, next: NonNullable<typeof observer>) => {
    observer = next;
    handlers.start(
      { type: "subscribe", requestId: "r", subscriptionId: "s", method, input },
      {} as PaseoApi,
    );
    return Object.assign(() => handlers.release("s"), {
      ready: Promise.resolve(),
      release: async () => handlers.release("s"),
    });
  };
}

test("an event schema that transforms is applied once, on the receiving side", async () => {
  const handled: unknown[] = [];
  const received: number[] = [];
  const closed: unknown[] = [];
  const subscribe = connect(async (input, { push }) => {
    handled.push(input);
    await push("abc");
  });
  subscribePluginRpc(lengths, subscribe, { times: "2" }, (length) => received.push(length), {
    onClosed: (result) => closed.push(result),
  });
  await expect.poll(() => received).toEqual([3]);
  expect(handled).toEqual([{ times: 2 }]);
  expect(closed).toEqual([{}]);
});
