import { test } from "./fixtures";
import { DirectoryBootstrapScenario } from "./helpers/directory-bootstrap-scenario";

test.describe("Directory bootstrap correctness", () => {
  test("connect, pushed deltas, and reconnect keep directories current without duplicate bootstraps", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const scenario = await DirectoryBootstrapScenario.open(page);
    try {
      await scenario.expectDirectoryStarts(1);
      await scenario.stayConnectedWithoutRefetchAndApplyDeltas();
      await scenario.disconnectMutateAndReconnect();
      await scenario.expectVisibleReconciliationAndNavigateAgent();
    } finally {
      await scenario.cleanup();
    }
  });
});
