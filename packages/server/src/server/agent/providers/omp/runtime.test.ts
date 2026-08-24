import { expect, test } from "vitest";

import { OmpHarness } from "./test-utils/omp-harness.js";

test("falls back to progress when the event subscription is unavailable", async () => {
  const omp = new OmpHarness();
  omp.failEventSubscription(new Error("events unsupported"));
  await omp.start();

  await expect(omp.waitForSubscriptionFallback()).resolves.toEqual(["events", "progress"]);
});
