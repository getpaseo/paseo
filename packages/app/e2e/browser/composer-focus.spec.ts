import { test } from "../support/fixtures";
import {
  expectComposerDraft,
  expectComposerFocused,
  expectComposerVisible,
  submitMessage,
  typeIntoFocusedComposer,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test("submitting a message leaves the composer ready for the next message", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-focus-",
    title: "Composer focus",
  });

  try {
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);

    await submitMessage(page, "First message");
    await expectComposerFocused(page);

    await typeIntoFocusedComposer(page, "Second message");
    await expectComposerDraft(page, "Second message");
  } finally {
    await agent.cleanup();
  }
});
