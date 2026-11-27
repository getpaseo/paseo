import { afterEach, expect, test } from "vitest";
import type { DaemonTransport } from "@getpaseo/client/internal/daemon-client-transport-types";
import { EventEmitter } from "node:events";
import {
  encodeHostRouteFrame,
  MAX_HOST_ROUTE_ID_BYTES,
} from "@getpaseo/protocol/binary-frames/index";
import { DaemonLinkEndpoint, VirtualHostSocket } from "./link.js";
import { openReverseCarrier, acceptReverseCarrier } from "./reverse-carrier.js";
import { SessionDelivery } from "../session/owned-subscriptions/index.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function link(admitReverse?: (socket: VirtualHostSocket) => Promise<void>) {
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
    admitReverse,
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
  return { open, ack, frames, dispatch, messages, sockets };
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

test("a reverse carrier cannot fall through to ordinary channel admission", async () => {
  const host = await link();
  await host.dispatch({
    type: "hosts.link.open.request",
    requestId: "denied-reverse",
    channelId: "reverse",
    purpose: "reverse",
    peerServerId: "srv_dialer",
  });

  expect(host.messages).toEqual([
    {
      type: "rpc_error",
      payload: {
        requestId: "denied-reverse",
        requestType: "hosts.link.open.request",
        code: "permission_denied",
        error: "Reverse host access has not been approved",
      },
    },
  ]);
  expect(host.sockets).toEqual([]);
  await host.open("forward", false);
  expect(host.sockets).toHaveLength(1);
});

test("an approved reverse carrier preserves its frames and closes independently", async () => {
  const received: unknown[] = [];
  const reverseClosed = deferred();
  const host = await link(async (socket) => {
    socket.on("message", (data) => received.push(data));
    socket.once("close", () => reverseClosed.resolve());
  });
  const forward = await host.open("forward", false);
  await host.dispatch({
    type: "hosts.link.open.request",
    requestId: "reverse-open",
    channelId: "reverse",
    purpose: "reverse",
    peerServerId: "srv_dialer",
  });
  const opened = host.messages.find(
    (message) =>
      message.type === "hosts.link.open.response" && message.payload.requestId === "reverse-open",
  );
  if (opened?.type !== "hosts.link.open.response") throw new Error("Missing reverse carrier");
  const reverseId = opened.payload.routeId;
  expect(reverseId).not.toBe(forward.id);

  const welcome = JSON.stringify({ type: "status", payload: { status: "server_info" } });
  await host.dispatch({
    type: "hosts.route.frame.request",
    routeId: reverseId,
    data: welcome,
    binary: false,
  });
  expect(received).toEqual([welcome]);
  expect(host.sockets).toEqual([forward.socket]);

  await host.dispatch({ type: "hosts.route.close.request", routeId: reverseId });
  await reverseClosed.promise;
  await forward.socket.send("forward channel stays open");
  expect(host.frames()).toEqual(["forward channel stays open"]);
});

const reverseIdentity = {
  dialerServerId: "srv_dialer",
  acceptorServerId: "srv_acceptor",
  token: "a test token shared out of band between the hosts",
};

function reverseTransport(carrierFrameBytes?: number) {
  const dialer = new EventEmitter();
  const frames: Array<string | Uint8Array> = [];
  const socket = new VirtualHostSocket(
    async (data) => {
      frames.push(data);
      dialer.emit("message", data, typeof data !== "string");
    },
    (code, reason) => dialer.emit("close", { code, reason }),
    () => 0,
    (hello) => hello,
    carrierFrameBytes,
  );
  cleanup.push(async () => socket.close());
  function on(event: string, handler: (...args: never[]) => unknown): () => void {
    dialer.on(event, handler);
    return () => dialer.off(event, handler);
  }
  const transport: DaemonTransport = {
    maxFrameBytes: carrierFrameBytes,
    send(data) {
      const frame = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      frames.push(frame);
      socket.feed(frame);
    },
    close: (code, reason) => socket.close(code, reason),
    onOpen(handler) {
      let active = true;
      queueMicrotask(() => {
        if (active) handler();
      });
      return () => {
        active = false;
      };
    },
    onClose: (handler) => on("close", handler),
    onMessage: (handler) => on("message", handler),
    onError: (handler) => on("failure", handler),
  };
  return { frames, socket, transport };
}

test("authenticated reverse carriers preserve frames and close together", async () => {
  const carrierFrameBytes = 4096;
  const { frames, socket, transport } = reverseTransport(carrierFrameBytes);
  const atDialer: unknown[] = [];
  const atAcceptor: unknown[] = [];
  const dialerClosed = deferred();
  const acceptor = acceptReverseCarrier(socket, reverseIdentity);
  const dialer = openReverseCarrier(transport, reverseIdentity, async (virtualSocket) => {
    virtualSocket.on("message", (data) => atDialer.push(data));
    virtualSocket.once("close", () => dialerClosed.resolve());
  });
  const [factory, virtualSocket] = await Promise.all([acceptor, dialer]);
  const reverseClient = factory({ url: "ws://test/ws" });
  const maximumRouteId = "x".repeat(MAX_HOST_ROUTE_ID_BYTES);
  for (const frameBytes of [virtualSocket.maxFrameBytes, reverseClient.maxFrameBytes!]) {
    const wrappedBinary = encodeHostRouteFrame(maximumRouteId, new Uint8Array(frameBytes));
    expect(wrappedBinary.byteLength).toBeLessThanOrEqual(carrierFrameBytes);
    const wrappedText = JSON.stringify({
      type: "session",
      message: {
        type: "hosts.route.frame",
        payload: {
          binary: false,
          subscriptionId: maximumRouteId,
          data: "\u0000".repeat(frameBytes),
        },
      },
    });
    expect(Buffer.byteLength(wrappedText)).toBeLessThanOrEqual(carrierFrameBytes);
  }
  reverseClient.onMessage((data) => {
    atAcceptor.push(data);
  });
  await reverseClient.send("client hello");
  await virtualSocket.send(Uint8Array.of(0, 255, 24));
  expect(atDialer).toEqual(["client hello"]);
  expect(atAcceptor).toEqual([Buffer.from([0, 255, 24])]);
  expect(JSON.stringify(frames)).not.toContain(reverseIdentity.token);

  reverseClient.close();
  await dialerClosed.promise;
  expect(virtualSocket.readyState).toBe(3);
});

test.each([
  { token: "wrong token" },
  { dialerServerId: "srv_impersonator" },
  { acceptorServerId: "srv_impersonator" },
])(
  "the reverse peer must prove the approved token and endpoint identities (%o)",
  async (changes) => {
    const { socket, transport } = reverseTransport();
    const attached: VirtualHostSocket[] = [];
    const acceptor = acceptReverseCarrier(socket, { ...reverseIdentity, ...changes });
    const dialer = openReverseCarrier(transport, reverseIdentity, async (virtualSocket) => {
      attached.push(virtualSocket);
    });
    const outcomes = await Promise.allSettled([acceptor, dialer]);
    expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    expect(attached).toEqual([]);
    expect(socket.readyState).toBe(3);
  },
);

test("closing the physical link interrupts reverse authentication on both endpoints", async () => {
  const { socket, transport } = reverseTransport();
  const attaching = deferred();
  const finishAttachment = deferred();
  const acceptor = acceptReverseCarrier(socket, reverseIdentity);
  const dialer = openReverseCarrier(transport, reverseIdentity, async () => {
    attaching.resolve();
    await finishAttachment.promise;
  });
  await attaching.promise;
  transport.close();
  expect((await Promise.allSettled([acceptor, dialer])).map(({ status }) => status)).toEqual([
    "rejected",
    "rejected",
  ]);
  finishAttachment.resolve();
  expect(socket.readyState).toBe(3);
});

test("a reverse proof from an earlier carrier cannot be reused on a fresh challenge", async () => {
  const enrolled = reverseTransport();
  const [, firstSocket] = await Promise.all([
    acceptReverseCarrier(enrolled.socket, reverseIdentity),
    openReverseCarrier(enrolled.transport, reverseIdentity, async () => {}),
  ]);
  const priorProof = enrolled.frames.find(
    (frame) => typeof frame === "string" && JSON.parse(frame).type === "reverse.response",
  );
  if (typeof priorProof !== "string") throw new Error("Missing response from the first carrier");
  firstSocket.close();

  const fresh = reverseTransport();
  fresh.socket.once("message", () => void fresh.socket.send(priorProof));
  const attached: VirtualHostSocket[] = [];
  await expect(
    openReverseCarrier(fresh.transport, reverseIdentity, async (socket) => {
      attached.push(socket);
    }),
  ).rejects.toMatchObject({ code: "permission_denied" });
  expect(attached).toEqual([]);
  expect(fresh.socket.readyState).toBe(3);
});

test("closing a carrier before the peer proves its identity leaves it unattached", async () => {
  const { socket, transport } = reverseTransport();
  const sentChallenge = new Promise<void>((resolve) => socket.once("message", () => resolve()));
  const attached: VirtualHostSocket[] = [];
  const dialer = openReverseCarrier(transport, reverseIdentity, async (virtualSocket) => {
    attached.push(virtualSocket);
  });

  await sentChallenge;
  transport.close();
  await expect(dialer).rejects.toMatchObject({ code: "permission_denied" });
  expect(attached).toEqual([]);
  expect(socket.readyState).toBe(3);
});
