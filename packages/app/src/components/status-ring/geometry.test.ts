import { describe, expect, test } from "vitest";
import {
  STATUS_PULSE_PEAK_SCALE,
  STATUS_PULSE_PERIOD_MS,
  STATUS_RING_PERIOD_MS,
  getStatusPulseProgress,
  getStatusPulseScale,
} from "./geometry";

function progressAt(fractions: number[], epochMs = 0): number[] {
  return fractions.map((fraction) =>
    getStatusPulseProgress(epochMs + fraction * STATUS_PULSE_PERIOD_MS),
  );
}

describe("status pulse", () => {
  test("breathes from the running colour to the success colour and back once per period", () => {
    const progress = progressAt([0, 0.25, 0.5, 0.75, 1]);

    expect(progress.map((value) => Number(value.toFixed(6)))).toEqual([0, 0.5, 1, 0.5, 0]);
  });

  test("eases at both ends rather than turning sharply", () => {
    const step = 0.01;
    const [rest, afterRest, beforePeak, peak] = progressAt([0, step, 0.5 - step, 0.5]);

    // Near an extreme the curve is flat: a tenth of a mid-cycle step, not a full one.
    const midStep = getStatusPulseProgress((0.25 + step) * STATUS_PULSE_PERIOD_MS) - 0.5;
    expect(afterRest - rest).toBeLessThan(midStep / 10);
    expect(peak - beforePeak).toBeLessThan(midStep / 10);
  });

  test("is symmetric, so the way back retraces the way there", () => {
    const fractions = [0.05, 0.1, 0.2, 0.3, 0.4, 0.45];
    const there = progressAt(fractions);
    const back = progressAt(fractions.map((fraction) => 1 - fraction));

    back.forEach((value, index) => expect(value).toBeCloseTo(there[index] ?? Number.NaN, 9));
  });

  test("follows wall-clock time, so indicators mounted at different moments agree", () => {
    const epochMs = 1_792_670_000_000;
    const later = progressAt([0, 0.25, 0.5, 0.75], epochMs + STATUS_PULSE_PERIOD_MS * 7);
    const now = progressAt([0, 0.25, 0.5, 0.75], epochMs);

    later.forEach((value, index) => expect(value).toBeCloseTo(now[index] ?? Number.NaN, 9));
  });

  test("stays inside the colour mix's range over a whole period", () => {
    const samples = Array.from({ length: 271 }, (_, index) => getStatusPulseProgress(index * 10));

    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThanOrEqual(1);
  });

  test("grows the mark in step with the colour, from rest to its peak", () => {
    expect(getStatusPulseScale(0)).toBe(1);
    expect(getStatusPulseScale(0.5)).toBeCloseTo(1 + (STATUS_PULSE_PEAK_SCALE - 1) / 2, 9);
    expect(getStatusPulseScale(1)).toBe(STATUS_PULSE_PEAK_SCALE);
  });

  test("lasts a whole number of ring turns, so every pulse peaks at the same arc position", () => {
    expect(STATUS_PULSE_PERIOD_MS % STATUS_RING_PERIOD_MS).toBe(0);
  });
});
