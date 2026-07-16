import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UUID } from "builder-util-runtime";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(),
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: {},
}));

import {
  bucketFromStagingUserId,
  resolveStagingUserId,
  rolloutManifestSchema,
  shouldAdmitToRollout,
} from "./auto-updater";

describe("shouldAdmitToRollout", () => {
  it("admits beta, missing rollout hours, zero-hour rollout, and missing release date", () => {
    expect(
      shouldAdmitToRollout({
        channel: "beta",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: undefined,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 0,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: undefined,
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
  });

  it("blocks future releases and respects the linear threshold mid-rollout", () => {
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T02:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0,
      }),
    ).toBe(false);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.49,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.51,
      }),
    ).toBe(false);
  });

  it("blocks the bucket-zero client at exact release time, admits as soon as time advances", () => {
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T00:00:00.000Z"),
        bucket: 0,
      }),
    ).toBe(false);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T00:00:00.001Z"),
        bucket: 0,
      }),
    ).toBe(true);
  });

  it("admits the highest-bucket client at and past the rollout end", () => {
    const maxBucket = (0x100000000 - 1) / 0x100000000;
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-29T00:00:00.000Z"),
        bucket: maxBucket,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2027-04-28T00:00:00.000Z"),
        bucket: maxBucket,
      }),
    ).toBe(true);
  });

  it("admits when releaseDate is unparseable", () => {
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "not a date",
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
  });

  it("treats garbage manifest rollout fields as missing and admits", () => {
    const parsed = rolloutManifestSchema.parse({
      rolloutHours: "not a number",
      releaseDate: 12345,
    });

    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: parsed.rolloutHours,
        releaseDate: parsed.releaseDate,
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

  it("creates and then reuses the on-disk staging user id", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-updater-id-"));
    const filePath = path.join(tempDir, ".updaterId");

    try {
      const first = await resolveStagingUserId(filePath);
      const stored = (await readFile(filePath, "utf8")).trim();
      const second = await resolveStagingUserId(filePath);

      expect(UUID.check(stored)).toBeTruthy();
      expect(second).toBe(first);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
