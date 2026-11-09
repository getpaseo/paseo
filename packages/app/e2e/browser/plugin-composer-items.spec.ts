import { test } from "../support/fixtures";
import { withComposerControlsExample } from "../support/helpers/plugin-composer-items";

test("a narrow composer's overflow sheet shows a plugin item's row", async ({ page }) => {
  test.setTimeout(120_000);
  await withComposerControlsExample(page, async (composer) => {
    await composer.narrowTheWindow();
    await composer.openAgentFeatures();
    await composer.expectFeatureRow("Needs review");
    await composer.expectFeatureRow("Insert checklist");
  });
});
