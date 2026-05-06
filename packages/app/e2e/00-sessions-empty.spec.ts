// "00-" prefix is intentional: this file must sort before every other spec.
// Sessions history is daemon-global — any agent created by a prior spec hides the empty state.
// If the beforeAll probe below fails, a spec sorted before this file is creating agents.
import { test } from "./fixtures";
import {
  connectArchiveTabDaemonClient,
  expectSessionsEmptyState,
  openSessions,
} from "./helpers/archive-tab";

test.describe("Sessions screen empty state", () => {
  test.beforeAll(async () => {
    const client = await connectArchiveTabDaemonClient();
    try {
      const history = await client.fetchAgentHistory({ page: { limit: 1 } });
      if (history.entries.length > 0) {
        throw new Error(
          `Sessions empty-state precondition failed: daemon already has ${history.entries.length} agent(s). ` +
            `Either a spec that sorts before 00-sessions-empty.spec.ts created agents, ` +
            `or the daemon has stale history from a previous run.`,
        );
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  test("shows empty placeholder when there is no session history", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "sessions-empty-" });
    await workspace.navigateTo();
    await openSessions(page);
    await expectSessionsEmptyState(page);
  });
});
