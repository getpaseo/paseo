import { describe, expect, it } from "vitest";
import { getReconnectDelayMs } from "./reconnect-delay";

const options = { baseDelayMs: 1500, maxDelayMs: 30_000 };

describe("getReconnectDelayMs", () => {
  it("doubles the ceiling on each attempt", () => {
    const top = () => 1;
    expect(getReconnectDelayMs(0, options, top)).toBe(1500);
    expect(getReconnectDelayMs(1, options, top)).toBe(3000);
    expect(getReconnectDelayMs(2, options, top)).toBe(6000);
  });

  it("never waits longer than the max delay", () => {
    expect(getReconnectDelayMs(12, options, () => 1)).toBe(30_000);
  });

  it("spreads retries between half and the full ceiling", () => {
    expect(getReconnectDelayMs(3, options, () => 0)).toBe(6000);
    expect(getReconnectDelayMs(3, options, () => 0.5)).toBe(9000);
    expect(getReconnectDelayMs(3, options, () => 1)).toBe(12_000);
  });

  it("keeps the first retry under two seconds", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(getReconnectDelayMs(0, options)).toBeLessThanOrEqual(1500);
    }
  });
});
