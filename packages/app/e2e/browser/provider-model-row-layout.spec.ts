import { test } from "../support/helpers/model-visibility-fixture";
import { PROVIDER, checkModelRowLayout } from "../support/helpers/model-row-layout";

test.use({ catalogProvider: PROVIDER });

for (const compact of [false, true]) {
  test(`${compact ? "compact" : "desktop"} model rows keep controls aligned and text bounded`, async ({
    page,
    modelWorkspace,
  }) => {
    await page.setViewportSize(
      compact ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    );
    await checkModelRowLayout(page, modelWorkspace, compact);
  });
}
