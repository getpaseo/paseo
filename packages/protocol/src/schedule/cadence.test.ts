import { describe, expect, it } from "vitest";
import { everyMsToFiveFieldCron } from "./cadence.js";

describe("everyMsToFiveFieldCron", () => {
  it.each([
    [60_000, "*/1 * * * *"],
    [15 * 60_000, "*/15 * * * *"],
    [60 * 60_000, "0 * * * *"],
    [6 * 60 * 60_000, "0 */6 * * *"],
    [24 * 60 * 60_000, "0 0 * * *"],
  ])("converts %i milliseconds", (everyMs, cron) => {
    expect(everyMsToFiveFieldCron(everyMs)).toBe(cron);
  });

  it.each([30_000, 7 * 60_000, 5 * 60 * 60_000, 48 * 60 * 60_000])(
    "rejects unrepresentable interval %i",
    (everyMs) => {
      expect(everyMsToFiveFieldCron(everyMs)).toBeNull();
    },
  );
});
