import { test } from "../support/fixtures";
import { withButtonAuthorExample } from "../support/helpers/plugin-button-example";

test("the button author example shows each capability without a competing overflow button", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await withButtonAuthorExample(page, info, async (buttons) => {
    await buttons.refreshFromHeaderAndComposer();
    await buttons.useMenusAndToggleButtons();
    await buttons.inspectLiveWorkspaceDetails();
  });
});
