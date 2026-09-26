import { describe, expect, it } from "vitest";
import { computeDownloadProgress } from "@/utils/download-progress";

describe("computeDownloadProgress", () => {
  it("derives percent, speed, and eta from bytes received since the start", () => {
    expect(
      computeDownloadProgress({
        receivedBytes: 250,
        totalBytes: 1000,
        startedAt: 10_000,
        now: 12_000,
      }),
    ).toEqual({
      percent: 0.25,
      bytesWritten: 250,
      totalBytes: 1000,
      speed: 125,
      eta: 6,
    });
  });

  it("reports zero speed and eta before any time has elapsed", () => {
    expect(
      computeDownloadProgress({ receivedBytes: 0, totalBytes: 1000, startedAt: 5, now: 5 }),
    ).toEqual({ percent: 0, bytesWritten: 0, totalBytes: 1000, speed: 0, eta: 0 });
  });

  it("returns null when the total size is unknown", () => {
    expect(
      computeDownloadProgress({ receivedBytes: 10, totalBytes: 0, startedAt: 0, now: 1000 }),
    ).toBeNull();
  });
});
