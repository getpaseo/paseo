import { afterEach, expect, test } from "vitest";
import { DaemonLinkEndpoint, type VirtualHostSocket } from "./index.js";
import { SessionDelivery } from "../session/owned-subscriptions/index.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function link() {
  const source = {};
  const messages: SessionOutboundMessage[] = [];
  const sockets: VirtualHostSocket[] = [];
  const delivery = new SessionDelivery((_source, message) => {
    messages.push(message);
  });
  delivery.attach(source, true);
  const endpoint = new DaemonLinkEndpoint({
    identity: "physical",
    permissions: () => ["daemon.read"],
    routed: () => false,
    bufferedAmount: () => 0,
    delivery,
    admit: async (socket) => {
      sockets.push(socket);
    },
  });
  cleanup.push(async () => {
    endpoint.close();
    await delivery.close();
  });
  const dispatch = (message: SessionInboundMessage) =>
    delivery.request(source, message, () => endpoint.dispatch(message));
  const open = async (channelId: string, flowControl = true) => {
    await dispatch({
      type: "hosts.link.open.request",
      requestId: channelId,
      channelId,
      flowControl,
    });
    const response = messages.find(
      (message) =>
        message.type === "hosts.link.open.response" && message.payload.requestId === channelId,
    );
    expect(response).toMatchObject({
      type: "hosts.link.open.response",
      payload: flowControl ? { flowControl: true } : {},
    });
    if (response?.type !== "hosts.link.open.response") throw new Error("Missing opened channel");
    return { socket: sockets.at(-1)!, id: response.payload.routeId };
  };
  const ack = (routeId: string, sequence: number) =>
    dispatch({ type: "hosts.link.ack.request", routeId, sequence });
  const frames = () =>
    messages
      .filter((message) => message.type === "hosts.route.frame")
      .map((message) => message.payload.data);
  return { open, ack, frames };
}

test("a channel waits for forwarding acknowledgments while its sibling keeps sending", async () => {
  const host = await link();
  const slow = await host.open("slow");
  const sibling = await host.open("sibling");
  let completed = false;
  const first = slow.socket.send("first").then(() => {
    completed = true;
    return undefined;
  });
  let secondCompleted = false;
  const second = slow.socket.send("second").then(() => {
    secondCompleted = true;
    return undefined;
  });
  await expect.poll(host.frames).toEqual(["first", "second"]);
  expect(completed).toBe(false);
  const independent = sibling.socket.send("independent");
  await expect.poll(host.frames).toEqual(["first", "second", "independent"]);
  await host.ack(sibling.id, 1);
  await independent;
  await host.ack(slow.id, 1);
  await first;
  await expect.poll(host.frames).toEqual(["first", "second", "independent"]);
  await host.ack(slow.id, 1); // A duplicate acknowledgment cannot release the next frame.
  expect(completed).toBe(true);
  expect(secondCompleted).toBe(false);
  await host.ack(slow.id, 2);
  await second;
});

test("closing a blocked channel rejects its pending writes and leaves a sibling usable", async () => {
  const host = await link();
  const slow = await host.open("slow");
  const sibling = await host.open("sibling", false);
  const first = slow.socket.send("first");
  const second = slow.socket.send("second");
  const results = Promise.allSettled([first, second]);
  await expect.poll(host.frames).toEqual(["first", "second"]);
  slow.socket.close();
  expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
  await sibling.socket.send("legacy sibling");
  expect(host.frames()).toEqual(["first", "second", "legacy sibling"]);
});

test("an unpaced producer exhausting its acknowledgment window closes only its channel", async () => {
  const host = await link();
  const slow = await host.open("slow");
  const sibling = await host.open("sibling", false);
  const writes: Promise<unknown>[] = [];
  // A producer ignoring send completion must remain bounded even for tiny messages.
  for (let index = 0; index < 5000; index++)
    writes.push(slow.socket.send("x").catch((error: unknown) => error));
  await Promise.all(writes);
  expect(slow.socket.readyState).toBe(3);
  await sibling.socket.send("still connected");
  expect(host.frames().at(-1)).toBe("still connected");
});
