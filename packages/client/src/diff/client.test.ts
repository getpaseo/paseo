import { expect, test } from "vitest";
import { DaemonClient, type DaemonTransport } from "../daemon-client.js";
import {
  encodeDiffFrame,
  DiffOpcode,
  type DiffFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type { DiffState } from "./index.js";
function socket() {
  let message: (data: unknown, binary?: boolean) => void = () => {};
  let open: () => void = () => {};
  let close: (event?: unknown) => void = () => {};
  const sent: Record<string, unknown>[] = [];
  const transport: DaemonTransport = {
    send: (data) => {
      if (typeof data === "string") {
        const value = JSON.parse(data);
        if (value.type === "session") {
          sent.push(value.message);
          if (value.message.type === "subscription.release.request")
            queueMicrotask(() =>
              receive({
                type: "subscription.release.response",
                payload: {
                  requestId: value.message.requestId,
                  subscriptionId: value.message.subscriptionId,
                  released: true,
                },
              }),
            );
        }
      }
    },
    close: () => {},
    onMessage: (handler) => {
      message = handler;
      return () => {};
    },
    onOpen: (handler) => {
      open = handler;
      return () => {};
    },
    onClose: (handler) => {
      close = handler;
      return () => {};
    },
    onError: () => () => {},
  };
  const receive = (value: unknown) =>
    message(JSON.stringify({ type: "session", message: value }), false);
  return {
    transport,
    sent,
    receive,
    raw: (bytes: Uint8Array) => message(bytes, true),
    frame: (frame: DiffFrame) => message(encodeDiffFrame(frame), true),
    disconnect: () => close({ code: 1001 }),
    open: (modern = true) => {
      open();
      receive({
        type: "status",
        payload: {
          status: "server_info",
          serverId: "srv_test",
          hostname: null,
          version: null,
          features: { ownedSubscriptions: true, diffSubscription: modern, checkoutDiffAll: true },
        },
      });
    },
  };
}
const compare = {
  cwd: "/repo",
  base: { kind: "rev", rev: "HEAD" },
  head: { kind: "worktree" },
} as const;
const begin: DiffFrame = {
  opcode: DiffOpcode.Begin,
  slot: 3,
  revision: 1,
  baseRevision: 0,
  baseSha: "a",
  headSha: "b",
  mergeBaseSha: "",
  entries: [],
};
const end: DiffFrame = {
  opcode: DiffOpcode.End,
  slot: 3,
  revision: 1,
  diffTooLarge: false,
  omitted: [],
  error: null,
};
async function setup(modern = true) {
  const wire = socket();
  const client = new DaemonClient({
    url: "ws://test",
    clientId: "diff-test",
    transportFactory: () => wire.transport,
    reconnect: { enabled: false },
  });
  const connecting = client.connect();
  wire.open(modern);
  await connecting;
  return { wire, client };
}
function acknowledge(wire: ReturnType<typeof socket>, ordinal = 1) {
  const request = wire.sent.findLast((value) => value.type === "diff.subscribe.request");
  wire.receive({
    type: "diff.subscribe.response",
    payload: {
      requestId: request?.requestId,
      subscriptionId: `diff-${ordinal}`,
      slot: 3,
      error: null,
    },
  });
}
test("attaches binary routing during handshake and resubscribes with a full state on reconnect", async () => {
  const { wire, client } = await setup();
  try {
    const states: DiffState[] = [];
    const observation = client.observeDiff(compare);
    observation.subscribe({ snapshot: (state) => states.push(state), update: () => {} });
    acknowledge(wire);
    wire.frame(begin);
    wire.frame(end);
    expect(states.map((state) => state.phase)).toEqual(["loading", "ready"]);
    wire.disconnect();
    const connected = client.connect();
    wire.open();
    await connected;
    acknowledge(wire, 2);
    wire.frame(begin);
    wire.frame(end);
    expect(states.map((state) => state.phase)).toEqual(["loading", "ready", "loading", "ready"]);
    await observation.release();
  } finally {
    await client.close();
  }
});
test("an unknown version fails only its subscription and readDiff resolves typed subscribe errors", async () => {
  const { wire, client } = await setup();
  try {
    const observation = client.observeDiff(compare);
    const states: DiffState[] = [];
    observation.subscribe({ snapshot: (state) => states.push(state), update: () => {} });
    acknowledge(wire);
    const malformed = { ...begin, slot: 3 };
    const bytes = encodeDiffFrame(malformed);
    bytes[2] = 255;
    wire.raw(bytes);
    expect(states.at(-1)).toMatchObject({ phase: "error", error: { code: "UNKNOWN" } });
    const next = client.readDiff(compare);
    const request = wire.sent.findLast((value) => value.type === "diff.subscribe.request");
    wire.receive({
      type: "diff.subscribe.response",
      payload: {
        requestId: request?.requestId,
        subscriptionId: "",
        slot: 0,
        error: { code: "INVALID_COMPARE", message: "invalid" },
      },
    });
    expect(await next).toMatchObject({ phase: "error", error: { code: "INVALID_COMPARE" } });
    expect(client.isConnected).toBe(true);
    await observation.release();
  } finally {
    await client.close();
  }
});
test.each(["uncommitted", "base", "all"] as const)(
  "old hosts serve the %s comparison through the tagged compatibility route",
  async (mode) => {
    const { wire, client } = await setup(false);
    try {
      const comparison =
        mode === "uncommitted"
          ? compare
          : {
              ...compare,
              base: { kind: "rev", rev: "refs/tags/v1" } as const,
              head: mode === "base" ? ({ kind: "rev", rev: "HEAD" } as const) : compare.head,
              mergeBase: true,
            };
      const result = client.readDiff(comparison);
      const request = wire.sent.find((value) => value.type === "subscribe_checkout_diff_request");
      expect(request?.compare).toMatchObject({ mode });
      wire.receive({
        type: "subscribe_checkout_diff_response",
        payload: {
          requestId: request?.requestId,
          subscriptionId: "legacy",
          cwd: "/repo",
          files: [],
          error: null,
        },
      });
      wire.receive({
        type: "checkout_diff_update",
        payload: { subscriptionId: "legacy", cwd: "/repo", files: [], error: null },
      });
      expect(await result).toMatchObject({ phase: "ready", files: [] });
    } finally {
      await client.close();
    }
  },
);
