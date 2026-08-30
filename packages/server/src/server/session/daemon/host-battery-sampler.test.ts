import { describe, expect, it } from "vitest";

import { HostBatterySampler } from "./host-battery-sampler.js";
import type { HostBatteryProbe } from "./host-battery.js";

/**
 * The sampler is driven by an injected tick rather than real timers so every test is
 * deterministic: `tick()` runs one cycle and resolves once the probe it started has settled.
 */
function createHarness(probes: HostBatteryProbe[], options?: { hasClients?: () => boolean }) {
  const changes: Array<{ percent: number } | null> = [];
  const queue = [...probes];
  let last: HostBatteryProbe = { outcome: "failed" };
  let fire: (() => void) | null = null;

  const sampler = new HostBatterySampler({
    onChange: (battery) => changes.push(battery ? { percent: battery.percent } : null),
    hasClients: options?.hasClients ?? (() => true),
    probe: async () => {
      last = queue.shift() ?? last;
      return last;
    },
    setIntervalFn: ((callback: () => void) => {
      fire = callback;
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
    clearIntervalFn: (() => {
      fire = null;
    }) as unknown as typeof clearInterval,
  });

  return {
    sampler,
    changes,
    isStopped: () => fire === null,
    async tick() {
      // `start` also samples immediately, so the first tick is the constructor's own probe.
      await sampler.sampleNow();
    },
  };
}

describe("HostBatterySampler", () => {
  it("reports the first reading and then only whole-percent changes", async () => {
    const harness = createHarness([
      { outcome: "ok", battery: { percent: 37 } },
      { outcome: "ok", battery: { percent: 37.4 } },
      { outcome: "ok", battery: { percent: 36 } },
    ]);
    harness.sampler.start();
    await harness.tick();
    await harness.tick();
    await harness.tick();

    // 37.4 rounds to the 37 already reported, so it is not a change the badge would show.
    expect(harness.changes).toEqual([{ percent: 37 }, { percent: 36 }]);
  });

  it("reports absence once and stops sampling a host with no battery", async () => {
    const harness = createHarness([{ outcome: "absent" }]);
    harness.sampler.start();
    await harness.tick();
    await harness.tick();

    expect(harness.changes).toEqual([null]);
    expect(harness.isStopped()).toBe(true);
  });

  it("keeps retrying a failing probe and settles only after repeated failure", async () => {
    const harness = createHarness([{ outcome: "failed" }]);
    harness.sampler.start();
    await harness.tick();
    await harness.tick();
    expect(harness.changes).toEqual([]);
    expect(harness.isStopped()).toBe(false);

    await harness.tick();
    expect(harness.changes).toEqual([null]);
    expect(harness.isStopped()).toBe(true);
  });

  it("recovers without settling when a probe succeeds after a failure", async () => {
    const harness = createHarness([
      { outcome: "failed" },
      { outcome: "failed" },
      { outcome: "ok", battery: { percent: 80 } },
      { outcome: "failed" },
      { outcome: "failed" },
    ]);
    harness.sampler.start();
    for (let i = 0; i < 5; i += 1) {
      await harness.tick();
    }

    // The success resets the failure count, so the two later failures do not reach the limit.
    expect(harness.changes).toEqual([{ percent: 80 }]);
    expect(harness.isStopped()).toBe(false);
  });

  it("does not probe while no client is connected", async () => {
    let connected = false;
    const harness = createHarness([{ outcome: "ok", battery: { percent: 50 } }], {
      hasClients: () => connected,
    });
    harness.sampler.start();
    await harness.tick();
    expect(harness.changes).toEqual([]);

    connected = true;
    await harness.tick();
    expect(harness.changes).toEqual([{ percent: 50 }]);
  });

  it("withholds a reading from server_info until a probe has landed", async () => {
    const harness = createHarness([{ outcome: "absent" }]);
    harness.sampler.start();
    // `undefined` keeps an unmeasured host distinguishable from one with no battery, which
    // is what stops the handshake from claiming a laptop has no battery.
    expect(harness.sampler.getCurrent()).toBeUndefined();

    await harness.tick();
    expect(harness.sampler.getCurrent()).toBeNull();
  });

  it("shares one in-flight probe between overlapping ticks", async () => {
    let probeCount = 0;
    let release: (() => void) | null = null;
    const sampler = new HostBatterySampler({
      onChange: () => {},
      hasClients: () => true,
      probe: async () => {
        probeCount += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { outcome: "ok", battery: { percent: 10 } };
      },
    });

    const first = sampler.sampleNow();
    const second = sampler.sampleNow();
    expect(probeCount).toBe(1);

    release?.();
    await Promise.all([first, second]);
    expect(probeCount).toBe(1);
  });
});
