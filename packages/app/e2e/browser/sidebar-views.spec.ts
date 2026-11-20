import { test } from "../support/fixtures";
import { withSidebarViews } from "../support/helpers/sidebar-views";

test("sidebar views replace the content, preserve chrome, and recover to the default", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await withSidebarViews(page, async (views) => {
    await views.expectDefault();
    await views.chooseWorkspaces();
    await views.exerciseExamples();
    await views.exerciseTerminals();
    await views.restoreDefault();
    await views.recoverFromFailure();
    await views.chooseWorkspaces();
    await views.disableChosenView();
  });
});
