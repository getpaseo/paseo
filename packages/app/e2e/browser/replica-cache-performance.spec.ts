import { test, expect } from "../support/fixtures";
import { expectAgentIdle } from "../support/helpers/agent-stream";
import { expectComposerVisible, submitMessage } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  beginReplicaCacheMeasurement,
  observeReplicaCacheWrites,
  readReplicaCacheMeasurement,
} from "../support/helpers/replica-cache-perf";

const RUN_REPLICA_CACHE_PERF = process.env.PASEO_REPLICA_CACHE_PERF_E2E === "1";
const replicaCachePerfDescribe = RUN_REPLICA_CACHE_PERF ? test.describe : test.describe.skip;
const MAX_STREAM_WRITES = 12;
const MAX_SERIALIZED_CHARS = 190_000;

replicaCachePerfDescribe("Replica cache performance", () => {
  test("streaming writes only persisted replica changes", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await observeReplicaCacheWrites(page);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "replica-cache-perf-",
      title: "Replica cache performance",
      model: "ten-second-stream",
    });

    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await beginReplicaCacheMeasurement(page);

      await submitMessage(page, "Measure replica persistence during a sustained stream.");
      await agent.client.waitForFinish(agent.agentId, 20_000);
      await expectAgentIdle(page);
      await page.waitForTimeout(1_000);

      const report = await readReplicaCacheMeasurement(page);
      await testInfo.attach("replica-cache-performance", {
        body: JSON.stringify(report, null, 2),
        contentType: "application/json",
      });
      console.log(`[perf] Replica cache: ${JSON.stringify(report)}`);

      expect(
        report.writes,
        "streaming should not continuously persist transient state",
      ).toBeLessThanOrEqual(MAX_STREAM_WRITES);
      expect(report.redundantWrites).toBe(0);
      expect(report.serializedChars).toBeLessThanOrEqual(MAX_SERIALIZED_CHARS);
    } finally {
      await agent.cleanup();
    }
  });
});
