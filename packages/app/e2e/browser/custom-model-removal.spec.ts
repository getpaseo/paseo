import { test } from "../support/fixtures";
import {
  addCustomModel,
  expectCustomModelRetained,
  openCustomModels,
  removeCustomModel,
} from "../support/helpers/custom-models";

const longModelId = "custom-model-with-a-long-name-".repeat(6);
const shortModelId = "custom-short";

for (const width of [1200, 390]) {
  test(`removes a long custom model at ${width}px without removing another model`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 1000 });
    await openCustomModels(page);
    await addCustomModel(page, shortModelId);
    await addCustomModel(page, longModelId);

    await test.step("remove the long model at the target width", async () => {
      await page.setViewportSize({ width, height: 1000 });
      await removeCustomModel(page, longModelId);
      await expectCustomModelRetained(page, shortModelId);
    });

    await removeCustomModel(page, shortModelId);
  });
}
