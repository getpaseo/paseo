import { describe, expect, it } from "vitest";
import { createAddHostFlow, parseRemoteHostInput } from "./model";

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
});

describe("remote host form input", () => {
  it("reads ET ports from the target and its Paseo password from the password field", () => {
    expect(
      parseRemoteHostInput(
        "et",
        " et://deploy@build-box:2023?sshPort=2222&daemonPort=7777 ",
        " s3cret ",
      ),
    ).toEqual({
      method: "et",
      target: {
        host: "deploy@build-box",
        etPort: 2023,
        sshPort: 2222,
        daemonPort: 7777,
        password: " s3cret ",
      },
    });
  });

  it("keeps the ET password field separate from the address", () => {
    expect(() => parseRemoteHostInput("et", "et://build-box?password=secret", "")).toThrow();
  });
});
