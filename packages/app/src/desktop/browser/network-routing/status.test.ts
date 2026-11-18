import { afterEach, describe, expect, it } from "vitest";
import { useNetworkRoutingStatus } from "./status";

afterEach(() => useNetworkRoutingStatus.setState({ hosts: {} }));

describe("host network status", () => {
  it("increments the reload generation only when a provider becomes ready", () => {
    const { setStatus } = useNetworkRoutingStatus.getState();
    expect(useNetworkRoutingStatus.getState().hosts).toEqual({});
    for (const status of ["idle", "connecting", "permission_denied"] as const) {
      setStatus("remote", status);
      expect(useNetworkRoutingStatus.getState().hosts).toEqual({
        remote: { status, generation: 0 },
      });
    }
    setStatus("remote", "ready");
    const firstReadyGeneration = useNetworkRoutingStatus.getState().hosts.remote.generation;
    expect(useNetworkRoutingStatus.getState().hosts.remote.status).toBe("ready");
    expect(firstReadyGeneration).toBeGreaterThan(0);
    setStatus("remote", "idle");
    setStatus("remote", "connecting");
    expect(useNetworkRoutingStatus.getState().hosts.remote).toEqual({
      status: "connecting",
      generation: firstReadyGeneration,
    });
    setStatus("remote", "ready");
    setStatus("remote", "ready");
    const readyAgain = useNetworkRoutingStatus.getState().hosts.remote;
    expect(readyAgain.status).toBe("ready");
    expect(readyAgain.generation).toBeGreaterThan(firstReadyGeneration);
  });

  it("keeps status and reload generations isolated by host", () => {
    const { setStatus } = useNetworkRoutingStatus.getState();
    setStatus("a", "ready");
    const previous = useNetworkRoutingStatus.getState().hosts;
    const previousA = previous.a;
    setStatus("b", "permission_denied");
    expect(useNetworkRoutingStatus.getState().hosts.a).toEqual(previousA);
    expect(useNetworkRoutingStatus.getState().hosts.b).toEqual({
      status: "permission_denied",
      generation: 0,
    });
    expect(previous).toEqual({ a: previousA });
  });
});
