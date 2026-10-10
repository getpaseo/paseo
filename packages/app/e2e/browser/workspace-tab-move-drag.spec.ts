import { expect, test } from "../support/fixtures";
import { gotoWorkspace, pressNewTabShortcut } from "../support/helpers/launcher";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  beginTabMoveDrag,
  expectNoTabMoveAffordances,
  expectTabMoveAffordances,
  firstTabChip,
  tabChip,
} from "../support/helpers/tab-move-drag";

/**
 * Dragging a tab onto a sidebar workspace row offers two affordances: a
 * floating "Move to workspace…" label and a blue frame around the target row.
 * Both only apply to an agent tab hovering a same-host workspace row that is
 * not its source, and the frame has to survive the sidebar re-rendering
 * mid-drag.
 */

let source: SeededWorkspace;
let target: SeededWorkspace;
let agentId: string;

test.beforeAll(async () => {
  source = await seedWorkspace({ repoPrefix: "tab-move-drag-source-" });
  target = await seedWorkspace({ repoPrefix: "tab-move-drag-target-" });
  const agent = await source.client.createAgent({
    provider: "mock",
    cwd: source.repoPath,
    workspaceId: source.workspaceId,
    title: "Movable agent",
    modeId: "load-test",
    model: "e2e-fast-stream",
  });
  agentId = agent.id;
});

test.afterAll(async () => {
  await source?.cleanup();
  await target?.cleanup();
});

test("a tab drag offers a workspace move only over a valid sidebar target", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await gotoWorkspace(page, source.workspaceId);
  const drag = await beginTabMoveDrag(page, tabChip(page, `agent_${agentId}`));

  await drag.acrossStrip(-48);
  await expectNoTabMoveAffordances(page);

  await drag.ontoSidebarChrome();
  await expectNoTabMoveAffordances(page);

  await drag.ontoWorkspaceRow(`${getServerId()}:${target.workspaceId}`);
  await expectTabMoveAffordances(page);

  await drag.nudge();
  await expectTabMoveAffordances(page);

  await drag.drop();
  await expectNoTabMoveAffordances(page);
  await expect(tabChip(page, `agent_${agentId}`)).toHaveCount(0);
});

test("a non-agent tab never offers a workspace move", async ({ page, withWorkspace }) => {
  const plain = await withWorkspace({ prefix: "tab-move-drag-plain-" });
  await plain.navigateTo();
  await pressNewTabShortcut(page);

  const chip = firstTabChip(page);
  await expect(chip).toBeVisible({ timeout: 30_000 });
  const chipTestId = await chip.getAttribute("data-testid");
  const drag = await beginTabMoveDrag(page, chip);

  // A different workspace, so a broken non-agent guard would actually move it.
  await drag.ontoWorkspaceRow(`${getServerId()}:${target.workspaceId}`);
  await expectNoTabMoveAffordances(page);

  await drag.drop();
  await expect(page.getByTestId(chipTestId!)).toHaveCount(1);
});
