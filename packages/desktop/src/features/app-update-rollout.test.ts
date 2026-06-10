import { describe, expect, it } from "vitest";

import { bucketFromStagingUserId, shouldAdmitAppUpdate } from "./app-update-rollout";

describe("shouldAdmitAppUpdate", () => {
  it("keeps automatic stable updates behind the rollout window", () => {
    expect(
      shouldAdmitAppUpdate({
        channel: "stable",
        intent: "automatic",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.51,
      }),
    ).toBe(false);
  });

  it("lets manual stable checks bypass rollout admission", () => {
    expect(
      shouldAdmitAppUpdate({
        channel: "stable",
        intent: "manual",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
  });

  it("admits beta, missing rollout hours, zero-hour rollout, and missing release date", () => {
    expect(
      shouldAdmitAppUpdate({
        channel: "beta",
        intent: "automatic",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
    expect(
      shouldAdmitAppUpdate({
        channel: "stable",
        intent: "automatic",
        rolloutHours: undefined,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
    expect(
      shouldAdmitAppUpdate({
        channel: "stable",
        intent: "automatic",
        rolloutHours: 0,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
    expect(
      shouldAdmitAppUpdate({
        channel: "stable",
        intent: "automatic",
        rolloutHours: 24,
        releaseDate: undefined,
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
  });

  it("blocks future automatic releases and admits the same release manually", () => {
    const input = {
      channel: "stable" as const,
      rolloutHours: 24,
      releaseDate: "2026-04-28T02:00:00.000Z",
      now: Date.parse("2026-04-28T01:00:00.000Z"),
      bucket: 0,
    };

    expect(shouldAdmitAppUpdate({ ...input, intent: "automatic" })).toBe(false);
    expect(shouldAdmitAppUpdate({ ...input, intent: "manual" })).toBe(true);
  });

  it("blocks the bucket-zero client at exact release time, admits as soon as time advances", () => {
    expect(
      shouldAdmitAppUpdate({
        channel: "stable",
        intent: "automatic",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T00:00:00.000Z"),
        bucket: 0,
      }),
    ).toBe(false);
    expect(
      shouldAdmitAppUpdate({
        channel: "stable",
        intent: "automatic",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T00:00:00.001Z"),
        bucket: 0,
      }),
    ).toBe(true);
  });

  it("admits the highest-bucket automatic client at and past the rollout end", () => {
    const maxBucket = (0x100000000 - 1) / 0x100000000;
    expect(
      shouldAdmitAppUpdate({
        channel: "stable",
        intent: "automatic",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-29T00:00:00.000Z"),
        bucket: maxBucket,
      }),
    ).toBe(true);
    expect(
      shouldAdmitAppUpdate({
        channel: "stable",
        intent: "automatic",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2027-04-28T00:00:00.000Z"),
        bucket: maxBucket,
      }),
    ).toBe(true);
  });

  it("admits when releaseDate is unparseable", () => {
    expect(
      shouldAdmitAppUpdate({
        channel: "stable",
        intent: "automatic",
        rolloutHours: 24,
        releaseDate: "not a date",
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
  });

  it("maps the maximum 32-bit slot to a bucket strictly less than 1", () => {
    const allOnes = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const allZeros = "00000000-0000-0000-0000-000000000000";

    expect(bucketFromStagingUserId(allOnes)).toBeLessThan(1);
    expect(bucketFromStagingUserId(allOnes)).toBeGreaterThan(0.999);
    expect(bucketFromStagingUserId(allZeros)).toBe(0);
  });
});
