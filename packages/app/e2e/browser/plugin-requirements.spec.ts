import {
  test,
  openRequirementHost,
  expectPluginRunning,
} from "../support/helpers/plugin-requirements";

test("runs a plugin whose declared Paseo range excludes the app version", async ({
  page,
  requirementHost,
}, testInfo) => {
  await openRequirementHost(page, requirementHost);
  await expectPluginRunning(page);
  await page.screenshot({ path: testInfo.outputPath("plugin-running.png") });
});
