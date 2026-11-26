import { describe, expect, it } from "vitest";

import {
  isPacedRelease,
  rolloutAdmissionPercent,
  rolloutBucket,
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
} from "./app-update-rollout";

const RELEASE_DATE = "2026-04-28T00:00:00.000Z";
const RELEASE_TIME = Date.parse(RELEASE_DATE);
const HOUR_MS = 3_600_000;
const MAX_BUCKET = (0x100000000 - 1) / 0x100000000;

function admitsStable(input: {
  ageHours: number;
  bucket: number;
  rolloutHours?: number;
  intent?: "automatic" | "manual";
}): boolean {
  return shouldAdmitAppUpdate({
    channel: "stable",
    intent: input.intent ?? "automatic",
    rolloutHours: input.rolloutHours ?? 18,
    releaseDate: RELEASE_DATE,
    now: RELEASE_TIME + input.ageHours * HOUR_MS,
    bucket: input.bucket,
  });
}

describe("rolloutAdmissionPercent", () => {
  it("holds the default 18 hour rollout at 5% for 8 hours, then ramps linearly to 100%", () => {
    expect(rolloutAdmissionPercent({ rolloutHours: 18, ageHours: 0 })).toBe(5);
    expect(rolloutAdmissionPercent({ rolloutHours: 18, ageHours: 4 })).toBe(5);
    expect(rolloutAdmissionPercent({ rolloutHours: 18, ageHours: 8 })).toBe(5);
    expect(rolloutAdmissionPercent({ rolloutHours: 18, ageHours: 13 })).toBe(52.5);
    expect(rolloutAdmissionPercent({ rolloutHours: 18, ageHours: 18 })).toBe(100);
    expect(rolloutAdmissionPercent({ rolloutHours: 18, ageHours: 500 })).toBe(100);
  });

  it("never decreases as a release ages", () => {
    let previous = 0;
    for (let ageHours = 0; ageHours <= 20; ageHours += 0.25) {
      const percent = rolloutAdmissionPercent({ rolloutHours: 18, ageHours });
      expect(percent).toBeGreaterThanOrEqual(previous);
      previous = percent;
    }
  });

  it("shortens the canary hold to half of a rollout shorter than 16 hours", () => {
    expect(rolloutAdmissionPercent({ rolloutHours: 6, ageHours: 2.9 })).toBe(5);
    expect(rolloutAdmissionPercent({ rolloutHours: 6, ageHours: 3 })).toBe(5);
    expect(rolloutAdmissionPercent({ rolloutHours: 6, ageHours: 4.5 })).toBe(52.5);
    expect(rolloutAdmissionPercent({ rolloutHours: 6, ageHours: 6 })).toBe(100);
  });

  it("keeps the canary hold at 8 hours when a rollout is slowed down", () => {
    expect(rolloutAdmissionPercent({ rolloutHours: 72, ageHours: 8 })).toBe(5);
    expect(rolloutAdmissionPercent({ rolloutHours: 72, ageHours: 40 })).toBe(52.5);
    expect(rolloutAdmissionPercent({ rolloutHours: 72, ageHours: 72 })).toBe(100);
  });

  it("completes a tiny rollout without dividing by zero", () => {
    expect(rolloutAdmissionPercent({ rolloutHours: 0.001, ageHours: 0 })).toBe(5);
    expect(rolloutAdmissionPercent({ rolloutHours: 0.001, ageHours: 0.001 })).toBe(100);
    expect(rolloutAdmissionPercent({ rolloutHours: Number.MIN_VALUE, ageHours: 1 })).toBe(100);
  });

  it("treats a release dated slightly in the future as just released", () => {
    expect(rolloutAdmissionPercent({ rolloutHours: 18, ageHours: -1 })).toBe(5);
  });
});

describe("shouldAdmitAppUpdate", () => {
  it("admits only the canary bucket during the canary hold", () => {
    expect(admitsStable({ ageHours: 0, bucket: 0 })).toBe(true);
    expect(admitsStable({ ageHours: 4, bucket: 0.049 })).toBe(true);
    expect(admitsStable({ ageHours: 4, bucket: 0.05 })).toBe(false);
    expect(admitsStable({ ageHours: 8, bucket: 0.05 })).toBe(false);
    expect(admitsStable({ ageHours: 8, bucket: MAX_BUCKET })).toBe(false);
  });

  it("admits by bucket along the ramp", () => {
    expect(admitsStable({ ageHours: 13, bucket: 0.52 })).toBe(true);
    expect(admitsStable({ ageHours: 13, bucket: 0.53 })).toBe(false);
  });

  it("admits every bucket at and after the rollout end", () => {
    expect(admitsStable({ ageHours: 18, bucket: MAX_BUCKET })).toBe(true);
    expect(admitsStable({ ageHours: 24 * 365, bucket: MAX_BUCKET })).toBe(true);
  });

  it("lets manual checks bypass the rollout", () => {
    expect(admitsStable({ ageHours: 1, bucket: MAX_BUCKET, intent: "manual" })).toBe(true);
    expect(admitsStable({ ageHours: -48, bucket: MAX_BUCKET, intent: "manual" })).toBe(true);
  });

  it("admits everyone to an emergency release with rolloutHours 0", () => {
    expect(admitsStable({ ageHours: 0, bucket: MAX_BUCKET, rolloutHours: 0 })).toBe(true);
    expect(admitsStable({ ageHours: -48, bucket: MAX_BUCKET, rolloutHours: 0 })).toBe(true);
  });

  it("admits beta, missing rollout hours, and a missing or unparseable release date", () => {
    const base = {
      intent: "automatic" as const,
      rolloutHours: 18,
      releaseDate: RELEASE_DATE,
      now: RELEASE_TIME + HOUR_MS,
      bucket: MAX_BUCKET,
    };

    expect(shouldAdmitAppUpdate({ ...base, channel: "beta" })).toBe(true);
    expect(shouldAdmitAppUpdate({ ...base, channel: "stable", rolloutHours: undefined })).toBe(
      true,
    );
    expect(shouldAdmitAppUpdate({ ...base, channel: "stable", releaseDate: undefined })).toBe(true);
    expect(shouldAdmitAppUpdate({ ...base, channel: "stable", releaseDate: "not a date" })).toBe(
      true,
    );
  });

  it("keeps a client whose clock is slightly behind the release date in the canary hold", () => {
    expect(admitsStable({ ageHours: -1, bucket: 0.049 })).toBe(true);
    expect(admitsStable({ ageHours: -1, bucket: 0.05 })).toBe(false);
    expect(admitsStable({ ageHours: -2, bucket: 0.05 })).toBe(false);
  });

  it("admits a client whose clock is too far behind the release date to place on the curve", () => {
    // With releases shipping more often than the clock error, this client
    // would otherwise see every release as unreleased and never update.
    expect(admitsStable({ ageHours: -2.01, bucket: MAX_BUCKET })).toBe(true);
    expect(admitsStable({ ageHours: -24 * 365, bucket: MAX_BUCKET })).toBe(true);
  });

  it("treats garbage manifest rollout fields as missing and admits", () => {
    const parsed = rolloutManifestSchema.parse({
      rolloutHours: "not a number",
      releaseDate: 12345,
    });

    expect(
      shouldAdmitAppUpdate({
        channel: "stable",
        intent: "automatic",
        rolloutHours: parsed.rolloutHours,
        releaseDate: parsed.releaseDate,
        now: RELEASE_TIME + HOUR_MS,
        bucket: MAX_BUCKET,
      }),
    ).toBe(true);
  });

  it("parses the stamped rollout fields that older clients already read", () => {
    expect(rolloutManifestSchema.parse({ rolloutHours: 18, releaseDate: RELEASE_DATE })).toEqual({
      rolloutHours: 18,
      releaseDate: RELEASE_DATE,
    });
    expect(rolloutManifestSchema.parse({ rolloutHours: "18" }).rolloutHours).toBe(18);
    expect(rolloutManifestSchema.parse({ rolloutHours: -1 }).rolloutHours).toBeUndefined();
  });
});

describe("isPacedRelease", () => {
  it("paces only stable releases with a positive rollout duration", () => {
    expect(isPacedRelease({ channel: "stable", rolloutHours: 18 })).toBe(true);
    expect(isPacedRelease({ channel: "stable", rolloutHours: 0.5 })).toBe(true);
    expect(isPacedRelease({ channel: "stable", rolloutHours: 0 })).toBe(false);
    expect(isPacedRelease({ channel: "stable", rolloutHours: undefined })).toBe(false);
    expect(isPacedRelease({ channel: "beta", rolloutHours: 18 })).toBe(false);
  });
});

describe("rolloutBucket", () => {
  const stagingUserId = "3f2c1b6e-8a4d-5c7e-9b1a-2d3e4f5a6b7c";

  function stagingUserIdAt(index: number): string {
    return `00000000-0000-5000-8000-${index.toString(16).padStart(12, "0")}`;
  }

  it("is stable for one install and one version", () => {
    expect(rolloutBucket(stagingUserId, "1.2.4")).toBe(rolloutBucket(stagingUserId, "1.2.4"));
  });

  it("always lands in [0, 1)", () => {
    for (let index = 0; index < 2000; index += 1) {
      const bucket = rolloutBucket(stagingUserIdAt(index), "1.2.4");
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(1);
    }
  });

  it("gives one install a different bucket for each version", () => {
    const buckets = new Set(
      Array.from({ length: 50 }, (_, patch) => rolloutBucket(stagingUserId, `1.2.${patch}`)),
    );
    expect(buckets.size).toBe(50);
  });

  it("spreads installs evenly so about 5% land in the canary", () => {
    const installs = 20_000;
    let canary = 0;
    for (let index = 0; index < installs; index += 1) {
      if (rolloutBucket(stagingUserIdAt(index), "1.2.4") < 0.05) canary += 1;
    }
    expect(canary / installs).toBeGreaterThan(0.04);
    expect(canary / installs).toBeLessThan(0.06);
  });

  it("picks a fresh canary group for each version", () => {
    const installs = 20_000;
    let canaryForBoth = 0;
    for (let index = 0; index < installs; index += 1) {
      const id = stagingUserIdAt(index);
      if (rolloutBucket(id, "1.2.4") < 0.05 && rolloutBucket(id, "1.2.5") < 0.05) {
        canaryForBoth += 1;
      }
    }
    // Independent 5% groups overlap in about 0.25% of installs. A sticky bucket
    // would overlap in all 5%.
    expect(canaryForBoth / installs).toBeLessThan(0.01);
  });

  it("never leaves an install outside the canary for every version", () => {
    for (let index = 0; index < 200; index += 1) {
      const id = stagingUserIdAt(index);
      let canaryReleases = 0;
      for (let patch = 0; patch < 400; patch += 1) {
        if (rolloutBucket(id, `1.2.${patch}`) < 0.05) canaryReleases += 1;
      }
      expect(canaryReleases).toBeGreaterThan(0);
    }
  });
});
