import { expect, test as base } from "../support/fixtures";
import { expectAgentIdle } from "../support/helpers/agent-stream";
import { expectComposerVisible, submitMessage } from "../support/helpers/composer";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import {
  beginReplicaCacheMeasurement,
  observeReplicaCacheWrites,
  readReplicaCacheMeasurement,
} from "../support/helpers/replica-cache-perf";

const RUN_REPLICA_CACHE_PERF = process.env.PASEO_REPLICA_CACHE_PERF_E2E === "1";
const MAX_STREAM_WRITES = 12;
const MAX_SERIALIZED_CHARS = 45_000;

const test = base.extend<{ replicaCacheAgent: MockAgentWorkspace }>({
  replicaCacheAgent: async ({ page: _page }, provide) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "replica-cache-perf-",
      title: "Replica cache performance",
      model: "ten-second-stream",
    });
    try {
      await provide(agent);
    } finally {
      await agent.cleanup();
    }
  },
});
const replicaCachePerfDescribe = RUN_REPLICA_CACHE_PERF ? test.describe : test.describe.skip;

replicaCachePerfDescribe("Replica cache performance", () => {
  test("streaming writes only persisted replica changes", async ({
    page,
    replicaCacheAgent: agent,
  }, testInfo) => {
    test.setTimeout(60_000);
    await observeReplicaCacheWrites(page);
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
  });
});
