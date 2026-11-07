import { test } from "../support/fixtures";
import {
  expectWorkspaceShownIdle,
  finishAndArchiveAgent,
  startBackgroundAgent,
} from "../support/helpers/background-agents";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  expectSubagentRowGone,
  expectSubagentRowVisible,
  openSubagentsTrack,
  seedParentWithSubagent,
  seedSubagent,
} from "../support/helpers/subagents";
import { expectOnlyWorkspaceAgentTabsVisible } from "../support/helpers/workspace-tabs";

test.describe("Background agents", () => {
  let workspace: SeededWorkspace;

  test.beforeAll(async () => {
    workspace = await seedWorkspace({
      repoPrefix: "background-agents-",
      title: "Classifier workspace",
    });
  });

  test.afterAll(async () => {
    await workspace?.cleanup();
  });

  test("a background agent runs in an open workspace without announcing itself", async ({
    page,
  }) => {
    const agents = await seedParentWithSubagent(workspace, {
      parentTitle: "Feature agent",
      childTitle: "Visible helper",
    });
    await openAgentRoute(page, { workspaceId: agents.workspaceId, agentId: agents.parent.id });
    await openSubagentsTrack(page);
    await expectSubagentRowVisible(page, agents.child.id);

    const classifier = await test.step("a plugin starts a background agent", () =>
      startBackgroundAgent(workspace, { parentId: agents.parent.id, title: "Classifier" }));
    // A visible child created after the classifier reaches the app on the same stream, so once
    // its row shows, the app has processed the classifier too.
    const marker = await seedSubagent(workspace, {
      parentId: agents.parent.id,
      title: "Ordering marker",
    });

    await test.step("it stays out of the track, the tabs and the sidebar status", async () => {
      await expectSubagentRowVisible(page, marker.id);
      await expectSubagentRowGone(page, classifier.id);
      await expectOnlyWorkspaceAgentTabsVisible(page, [agents.parent.id]);
      await expectWorkspaceShownIdle(page, "Classifier workspace");
    });

    await test.step("the plugin reads its finish and archives it", async () => {
      await finishAndArchiveAgent(workspace, classifier.id);
      await expectOnlyWorkspaceAgentTabsVisible(page, [agents.parent.id]);
      await expectSubagentRowGone(page, classifier.id);
    });
  });
});
