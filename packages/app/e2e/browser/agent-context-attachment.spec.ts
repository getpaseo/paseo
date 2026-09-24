import { test } from "../support/fixtures";
import { withAgentContextExample } from "../support/helpers/agent-context";

test(
  "New Agent offers a recent transcript snapshot without a search query",
  async ({ page }, info) => {
    await withAgentContextExample(page, info, async (context) => {
      await context.openPickerFromNewAgent();
      await context.attachRecentSource();
      await context.expectAttachmentInDraft();
    });
  },
);
