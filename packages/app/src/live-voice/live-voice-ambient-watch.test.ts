import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  disableAmbientLiveVoiceWatches,
  enableAmbientLiveVoiceWatches,
  type LiveVoiceAmbientWatchDeps,
} from "./live-voice-ambient-watch";
import { getAmbientLiveVoiceWatch, resetRoutedLiveVoiceWork } from "./live-voice-work-registry";

interface FakeHost {
  serverId: string;
  supported?: boolean;
  connected?: boolean;
  result?: { enabled: boolean };
  error?: Error;
}

function createDeps(hosts: FakeHost[]) {
  const setLiveVoiceAgentWatch = vi.fn(async (input: { enabled: boolean }) => ({
    enabled: input.enabled,
  }));
  const release = vi.fn();
  const calls: { serverId: string; enabled: boolean }[] = [];

  const deps: LiveVoiceAmbientWatchDeps = {
    getSavedHosts: () => hosts.map(({ serverId }) => ({ serverId })),
    supportsAmbientReports: (serverId) =>
      hosts.find((host) => host.serverId === serverId)?.supported !== false,
    pinActiveConnection: (serverId) => {
      const host = hosts.find((candidate) => candidate.serverId === serverId);
      if (!host || host.connected === false) {
        return null;
      }
      return {
        client: {
          setLiveVoiceAgentWatch: async (input) => {
            calls.push({ serverId, enabled: input.enabled });
            if (host.error) {
              throw host.error;
            }
            return host.result ?? (await setLiveVoiceAgentWatch(input));
          },
        },
        release,
      };
    },
  };
  return { deps, calls, release };
}

describe("Live Voice ambient watch", () => {
  beforeEach(() => {
    resetRoutedLiveVoiceWork();
  });

  test("watches every capable host, including the one hosting the call", async () => {
    const { deps, calls } = createDeps([{ serverId: "source" }, { serverId: "laptop" }]);

    const enabled = await enableAmbientLiveVoiceWatches({
      sourceServerId: "source",
      liveSessionId: "live-1",
      deps,
    });

    expect(enabled.sort()).toEqual(["laptop", "source"]);
    expect(calls).toEqual([
      { serverId: "source", enabled: true },
      { serverId: "laptop", enabled: true },
    ]);
    expect(getAmbientLiveVoiceWatch("laptop")).toEqual({
      sourceServerId: "source",
      liveSessionId: "live-1",
    });
  });

  test("skips hosts that are too old or offline without failing the call", async () => {
    const { deps, calls } = createDeps([
      { serverId: "source" },
      { serverId: "old", supported: false },
      { serverId: "offline", connected: false },
    ]);

    const enabled = await enableAmbientLiveVoiceWatches({
      sourceServerId: "source",
      liveSessionId: "live-1",
      deps,
    });

    expect(enabled).toEqual(["source"]);
    expect(calls).toEqual([{ serverId: "source", enabled: true }]);
    expect(getAmbientLiveVoiceWatch("old")).toBeNull();
    expect(getAmbientLiveVoiceWatch("offline")).toBeNull();
  });

  test("does not trust a host that refused to watch", async () => {
    const { deps } = createDeps([
      { serverId: "source" },
      { serverId: "refuses", result: { enabled: false } },
    ]);

    const enabled = await enableAmbientLiveVoiceWatches({
      sourceServerId: "source",
      liveSessionId: "live-1",
      deps,
    });

    // Registration is optimistic so a fast report is not dropped; a host that
    // then said no has to be un-registered or it stays trusted to report.
    expect(enabled).toEqual(["source"]);
    expect(getAmbientLiveVoiceWatch("refuses")).toBeNull();
  });

  test("reports a host that threw and leaves the rest watching", async () => {
    const onError = vi.fn();
    const { deps } = createDeps([
      { serverId: "source" },
      { serverId: "broken", error: new Error("socket closed") },
    ]);

    const enabled = await enableAmbientLiveVoiceWatches({
      sourceServerId: "source",
      liveSessionId: "live-1",
      deps,
      onError,
    });

    expect(enabled).toEqual(["source"]);
    expect(onError).toHaveBeenCalledWith("broken", expect.any(Error));
    expect(getAmbientLiveVoiceWatch("broken")).toBeNull();
  });

  test("releases every pin it takes", async () => {
    const { deps, release } = createDeps([{ serverId: "source" }, { serverId: "laptop" }]);

    await enableAmbientLiveVoiceWatches({
      sourceServerId: "source",
      liveSessionId: "live-1",
      deps,
    });

    expect(release).toHaveBeenCalledTimes(2);
  });

  test("stops watching and forgets the hosts when the call ends", async () => {
    const { deps, calls } = createDeps([{ serverId: "source" }, { serverId: "laptop" }]);
    await enableAmbientLiveVoiceWatches({
      sourceServerId: "source",
      liveSessionId: "live-1",
      deps,
    });
    calls.length = 0;

    await disableAmbientLiveVoiceWatches({ liveSessionId: "live-1", deps });

    expect(calls).toEqual([
      { serverId: "source", enabled: false },
      { serverId: "laptop", enabled: false },
    ]);
    expect(getAmbientLiveVoiceWatch("source")).toBeNull();
    expect(getAmbientLiveVoiceWatch("laptop")).toBeNull();
  });

  test("does not disturb a newer call when an older call's teardown lands late", async () => {
    const { deps, calls } = createDeps([{ serverId: "source" }]);
    // The runtime does not await teardown, so a stop and the next start overlap.
    // This is the ordering that used to turn the new call's watch back off.
    await enableAmbientLiveVoiceWatches({
      sourceServerId: "source",
      liveSessionId: "live-2",
      deps,
    });
    calls.length = 0;

    await disableAmbientLiveVoiceWatches({ liveSessionId: "live-1", deps });

    expect(calls).toEqual([]);
    expect(getAmbientLiveVoiceWatch("source")).toEqual({
      sourceServerId: "source",
      liveSessionId: "live-2",
    });
  });
});
