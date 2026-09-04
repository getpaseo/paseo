import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  beginReplicaCacheObservation,
  finishReplicaCacheObservation,
  installReplicaCacheMeasurement,
  measureReplicaCacheRestore,
  type ReplicaCacheMeasurementReport,
} from "../support/helpers/replica-cache-measurement";

const RUN_MEASUREMENT = process.env.PASEO_REPLICA_CACHE_MEASUREMENT === "1";
const TARGET_URL = process.env.PASEO_REPLICA_CACHE_MEASUREMENT_URL;
const REPORT_PATH = process.env.PASEO_REPLICA_CACHE_MEASUREMENT_REPORT;
const OBSERVATION_MS = Number(process.env.PASEO_REPLICA_CACHE_MEASUREMENT_MS ?? 60_000);
const HYDRATED_SELECTOR =
  process.env.PASEO_REPLICA_CACHE_HYDRATED_SELECTOR ??
  '[data-testid="agent-chat-scroll"], [data-testid^="sidebar-workspace-row-"]';

const measurementDescribe = RUN_MEASUREMENT ? test.describe : test.describe.skip;

measurementDescribe("Replica cache live measurement", () => {
  test("observes persistence and cached restore without mutating the daemon", async ({
    page,
  }, testInfo) => {
    test.setTimeout(OBSERVATION_MS + 90_000);
    expect(TARGET_URL, "PASEO_REPLICA_CACHE_MEASUREMENT_URL must be a full app URL").toBeTruthy();
    expect(REPORT_PATH, "PASEO_REPLICA_CACHE_MEASUREMENT_REPORT must be set").toBeTruthy();

    await installReplicaCacheMeasurement(page);
    await page.goto(TARGET_URL!, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => undefined);

    const observation = await beginReplicaCacheObservation(page);
    await page.waitForTimeout(OBSERVATION_MS);
    const observed = await finishReplicaCacheObservation(page, observation, TARGET_URL!);
    const restoreMs = await measureReplicaCacheRestore(page, TARGET_URL!, HYDRATED_SELECTOR);
    const report: ReplicaCacheMeasurementReport = { ...observed, restoreMs };

    await mkdir(path.dirname(REPORT_PATH!), { recursive: true });
    await writeFile(REPORT_PATH!, `${JSON.stringify(report, null, 2)}\n`);
    await testInfo.attach("replica-cache-measurement", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    console.log(`[measurement] Replica cache: ${JSON.stringify(report)}`);

    expect(report.observationMs).toBeGreaterThanOrEqual(OBSERVATION_MS);
  });
});
