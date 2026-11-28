import { test } from "../support/fixtures";
import {
  openOverflowingWorkspaceTabs,
  panWorkspaceTabsWithWheel,
} from "../support/helpers/workspace-tabs-wheel-scroll";

test("a vertical mouse wheel pans the overflowing workspace tab strip", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "workspace-tabs-wheel-" });
  await openOverflowingWorkspaceTabs(page, workspace);
  await panWorkspaceTabsWithWheel(page);
});
