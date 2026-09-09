import { test } from "../support/fixtures";
import { withProjectSecondaryLabel } from "../support/helpers/project-secondary-label";

test("shows project context as a right-aligned secondary label", async ({ page }) => {
  await withProjectSecondaryLabel(page, (project) => project.expectRightAlignedPresentation());
});
