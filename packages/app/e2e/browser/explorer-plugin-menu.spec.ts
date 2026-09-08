import { test } from "../support/fixtures";
import {
  withExplorerPanelPlugins,
  expectWorkspacePanelsInExplorerLauncher,
  openWorkspacePanelFromExplorerMenu,
  expectIndependentExplorerPanelToggles,
  expectExplorerPanelWithFocusedAgent,
} from "../support/helpers/explorer-plugin-menu";

test("Explorer toggles workspace panels independently without inheriting agent context", async ({
  page,
}, testInfo) => {
  await withExplorerPanelPlugins(page, async (workspace) => {
    await test.step("the New Tab launcher offers compatible workspace panels", () =>
      expectWorkspacePanelsInExplorerLauncher(page));
    await test.step("the rail menu offers the same workspace panels", () =>
      openWorkspacePanelFromExplorerMenu(page, workspace, testInfo));
    await test.step("different panels and plugins keep independent selection and closing", () =>
      expectIndependentExplorerPanelToggles(page, workspace));
    await test.step("focusing an agent does not add agent panels to Explorer", () =>
      expectExplorerPanelWithFocusedAgent(page, workspace, testInfo));
  });
});
