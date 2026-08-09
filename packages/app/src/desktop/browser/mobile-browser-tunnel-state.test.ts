import { afterEach, describe, expect, test } from "vitest";
import type { MobileBrowserProxySession } from "@/native/mobile-browser-proxy";
import {
  claimMobileBrowserHost,
  requestMobileBrowserReload,
  setMobileBrowserTunnelReady,
  useMobileBrowserTunnelStore,
} from "./mobile-browser-tunnel-state";

const releases: Array<() => void> = [];

function session(sessionId: string): MobileBrowserProxySession {
  return {
    sessionId,
    host: "127.0.0.1",
    port: 3128,
    realm: `realm-${sessionId}`,
    username: "paseo",
    password: `password-${sessionId}`,
  };
}

afterEach(() => {
  while (releases.length > 0) {
    releases.pop()?.();
  }
});

describe("mobile Browser host lifecycle", () => {
  test("drops the previous proxy session when a newer host is selected", () => {
    releases.push(claimMobileBrowserHost("test-a", "host-a"));
    setMobileBrowserTunnelReady("host-a", session("a"));
    expect(useMobileBrowserTunnelStore.getState().session?.sessionId).toBe("a");

    releases.push(claimMobileBrowserHost("test-b", "host-b"));

    expect(useMobileBrowserTunnelStore.getState()).toMatchObject({
      activeServerId: "host-b",
      status: "starting",
      session: null,
    });
  });

  test("restores the remaining host as a fresh route after the active claim closes", () => {
    releases.push(claimMobileBrowserHost("test-a", "host-a"));
    const releaseB = claimMobileBrowserHost("test-b", "host-b");
    releases.push(releaseB);
    setMobileBrowserTunnelReady("host-b", session("b"));

    releases.pop()?.();

    expect(useMobileBrowserTunnelStore.getState()).toMatchObject({
      activeServerId: "host-a",
      status: "starting",
      session: null,
    });
  });

  test("increments the reload generation when browser data is cleared", () => {
    const before = useMobileBrowserTunnelStore.getState().reloadGeneration;
    requestMobileBrowserReload();
    expect(useMobileBrowserTunnelStore.getState().reloadGeneration).toBe(before + 1);
  });
});
