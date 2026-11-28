import { describe, expect, it } from "vitest";
import { createAddHostFlow } from "./model";

describe("add host flow", () => {
  it("closes before notifying the consumer and ignores duplicate completion", () => {
    const flow = createAddHostFlow();
    const added: string[] = [];
    flow.open({
      onAdded: (serverId) => {
        expect(flow.store.getState().session).toBeNull();
        added.push(serverId);
      },
    });
    const session = flow.store.getState().session!;
    session.choose("direct");
    session.complete({ serverId: "new-host" });
    session.complete({ serverId: "new-host" });
    expect(added).toEqual(["new-host"]);
  });

  it("cancels without a success action and accepts a fresh request", () => {
    const flow = createAddHostFlow();
    const added: string[] = [];
    flow.open({ onAdded: (id) => added.push(id) });
    const cancelled = flow.store.getState().session!;
    cancelled.choose("scan");
    cancelled.close();
    expect(flow.store.getState().session).toBeNull();
    flow.open({ method: "link" });
    const current = flow.store.getState().session!;
    cancelled.complete({ serverId: "late-result" });
    cancelled.close();
    expect(flow.store.getState().session).toBe(current);
    expect(current.step.getState()).toEqual({ method: "link" });
    expect(added).toEqual([]);
    current.complete({ serverId: "new-host" });
    expect(flow.store.getState().session).toBeNull();
  });

  it("returns to method selection within the same request", () => {
    const flow = createAddHostFlow();
    flow.open();
    const session = flow.store.getState().session!;
    session.choose("ssh");
    session.choose(null);
    expect(flow.store.getState().session).toBe(session);
    expect(session.step.getState()).toEqual({ method: null });
  });

  it("notifies dismissal for a replaced request and success only for the current request", () => {
    const flow = createAddHostFlow();
    const events: string[] = [];
    const options = {
      onDismiss: () => events.push("dismissed"),
      onAdded: (serverId: string) => events.push(serverId),
    };
    flow.open(options);
    const replaced = flow.store.getState().session!;
    flow.open(options);
    replaced.complete({ serverId: "stale" });
    flow.store.getState().session!.complete({ serverId: "approved" });
    expect(events).toEqual(["dismissed", "approved"]);
  });

  it("closes only the request that owns the returned cancellation handle", () => {
    const flow = createAddHostFlow();
    const dismissals: string[] = [];
    const cancelLinkRequest = flow.open({
      method: "ssh",
      onDismiss: () => dismissals.push("link"),
    });
    cancelLinkRequest();
    expect(flow.store.getState().session).toBeNull();

    flow.open({ method: "direct", onDismiss: () => dismissals.push("manual") });
    const manualRequest = flow.store.getState().session;
    cancelLinkRequest();

    expect(flow.store.getState().session).toBe(manualRequest);
    expect(dismissals).toEqual(["link"]);
  });
});
