import { expect, test } from "vitest";
import { ConnectedHostSession, type ConnectedHosts } from "./index.js";
import { SessionDelivery } from "../session/owned-subscriptions/index.js";

// The upstream host and final writer are independently controlled transport peers.
test.each(["text", "binary"] as const)(
  "routed %s completion waits for the final writer",
  async (kind) => {
    const source = {};
    const writing = Promise.withResolvers<void>();
    const drain = Promise.withResolvers<void>();
    const write = () => {
      writing.resolve();
      return drain.promise;
    };
    const delivery = new SessionDelivery((_source, message) => {
      if (message.type === "hosts.route.frame") return write();
    }, write);
    delivery.attach(source, true);
    let receive!: Parameters<ConnectedHosts["openRoute"]>[0]["frame"];
    const unexpected = (): never => {
      throw new Error("Unexpected host operation");
    };
    const session = new ConnectedHostSession(
      {
        list: unexpected,
        observe: unexpected,
        add: unexpected,
        update: unexpected,
        remove: unexpected,
        openRoute: async (input) => {
          receive = input.frame;
          return { send: () => {}, close: () => {} };
        },
      },
      delivery,
      { sourceId: "owner", manageSources: false },
      () => [],
      () => {},
      () => false,
      "origin",
      () => 0,
    );
    const request = {
      type: "hosts.route.open.request" as const,
      requestId: "open",
      serverId: "remote",
      scopeId: "scope",
    };
    await delivery.request(source, request, () => session.dispatch(request)!);
    let completed = false;
    const forwarded = Promise.resolve(
      receive(kind === "text" ? "payload" : new Uint8Array([1, 2])),
    ).then(() => {
      completed = true;
      return undefined;
    });
    try {
      await writing.promise;
      expect(completed).toBe(false);
      drain.resolve();
      await forwarded;
      expect(completed).toBe(true);
    } finally {
      drain.resolve();
      await forwarded;
      await delivery.close();
    }
  },
);
