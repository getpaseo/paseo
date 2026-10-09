import { test } from "../support/fixtures";
import {
  withExplorerPanelPlugins,
  expectWorkspacePanelsInExplorerLauncher,
  openWorkspacePanelFromExplorerMenu,
  expectIndependentExplorerPanelTabs,
  expectExplorerPanelWithFocusedAgent,
} from "../support/helpers/explorer-plugin-menu";

test("Explorer opens and closes workspace panel tabs independently without inheriting agent context", async ({
  page,
}, testInfo) => {
  await withExplorerPanelPlugins(page, async (workspace) => {
    await test.step("the + menu offers compatible workspace panels", () =>
      expectWorkspacePanelsInExplorerLauncher(page));
    await test.step("the + menu opens a workspace panel in Explorer", () =>
      openWorkspacePanelFromExplorerMenu(page, workspace, testInfo));
    await test.step("different panels and plugins keep independent selection and closing", () =>
      expectIndependentExplorerPanelTabs(page, workspace));
    await test.step("focusing an agent does not add agent panels to Explorer", () =>
      expectExplorerPanelWithFocusedAgent(page, workspace, testInfo));
  });
});
