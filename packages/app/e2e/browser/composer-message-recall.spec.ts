import type { Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { expectAgentIdle } from "../support/helpers/agent-stream";
import {
  composerLocator,
  expectComposerEditable,
  submitMessage,
} from "../support/helpers/composer";
import {
  installKeyCast,
  isRecordingVideo,
  keyCastBeat,
  keyCastStep,
} from "../support/helpers/key-cast";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const VIEWPORT = { width: 1440, height: 900 };

function caretOffset(composer: Locator): Promise<number> {
  return composer.evaluate((node: HTMLTextAreaElement) => node.selectionStart ?? 0);
}

const SENT = {
  oldest: "run the test suite",
  middle: "fix the flaky assertion in agent-stream",
  newest: "rebase the branch onto main",
};

// Recorded runs keep the video at viewport size, so the composer text is readable in the QA
// clip. Ordinary runs fall through to the project's own video setting.
test.use({
  video: isRecordingVideo() ? { mode: "on", size: VIEWPORT } : undefined,
});

test.describe("composer message recall", () => {
  test("walks sent messages with Up and Down, and gives the stashed draft back", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "composer-message-recall-",
      title: "Composer message recall",
      model: "ten-second-stream",
    });

    try {
      await page.setViewportSize(VIEWPORT);
      await installKeyCast(page);
      await openAgentRoute(page, agent);
      await expectComposerEditable(page);

      const composer = composerLocator(page);
      await keyCastStep(page, "Three prompts, sent from this composer.");
      for (const prompt of [SENT.oldest, SENT.middle, SENT.newest]) {
        await submitMessage(page, prompt);
        await expectAgentIdle(page, 60_000);
        await expect(composer).toHaveValue("");
      }

      await composer.click();

      await keyCastStep(page, "Up on the empty composer recalls the last one.");
      await composer.press("ArrowUp");
      await expect(composer).toHaveValue(SENT.newest);
      await keyCastBeat(page);

      await keyCastStep(page, "Up again keeps walking back.");
      await composer.press("ArrowUp");
      await expect(composer).toHaveValue(SENT.middle);
      await keyCastBeat(page);
      await composer.press("ArrowUp");
      await expect(composer).toHaveValue(SENT.oldest);
      await keyCastBeat(page);

      await keyCastStep(page, "It stops at the oldest instead of wrapping.");
      await composer.press("ArrowUp");
      await expect(composer).toHaveValue(SENT.oldest);
      await keyCastBeat(page);

      await keyCastStep(page, "Down walks forward, and lands back on the empty composer.");
      await composer.press("ArrowDown");
      await expect(composer).toHaveValue(SENT.middle);
      await keyCastBeat(page);
      await composer.press("ArrowDown");
      await expect(composer).toHaveValue(SENT.newest);
      await keyCastBeat(page);
      await composer.press("ArrowDown");
      await expect(composer).toHaveValue("");
      await keyCastBeat(page);

      await keyCastStep(page, "Now with a half typed prompt in the composer.");
      await composer.pressSequentially("deploy the staging", { delay: 45 });
      await expect(composer).toHaveValue("deploy the staging");
      await keyCastBeat(page);

      await keyCastStep(page, "Up stashes it and recalls, and the draft is not lost.");
      await composer.press("ArrowUp");
      await expect(composer).toHaveValue(SENT.newest);
      await keyCastBeat(page);

      await keyCastStep(page, "Down past the newest gives the stashed prompt back.");
      await composer.press("ArrowDown");
      await expect(composer).toHaveValue("deploy the staging");
      await keyCastBeat(page);

      await keyCastStep(page, "Editing a recalled message starts a new walk from it.");
      await composer.press("ArrowUp");
      await expect(composer).toHaveValue(SENT.newest);
      await composer.pressSequentially(", then push", { delay: 45 });
      await expect(composer).toHaveValue(`${SENT.newest}, then push`);
      await keyCastBeat(page);
      await composer.press("ArrowUp");
      await expect(composer).toHaveValue(SENT.newest);
      await keyCastBeat(page);
      await composer.press("ArrowDown");
      await expect(composer).toHaveValue(`${SENT.newest}, then push`);
      await keyCastBeat(page);

      await keyCastStep(page, "A multi-line draft keeps Up as cursor movement.");
      await composer.fill("");
      await composer.pressSequentially("first line", { delay: 45 });
      await composer.press("Shift+Enter");
      await composer.pressSequentially("second line", { delay: 45 });
      await expect(composer).toHaveValue("first line\nsecond line");
      await keyCastBeat(page);

      await keyCastStep(page, "Up from the second line only moves the caret.");
      await composer.press("ArrowUp");
      await expect(composer).toHaveValue("first line\nsecond line");
      expect(await caretOffset(composer)).toBeLessThanOrEqual("first line".length);
      await keyCastBeat(page);

      await keyCastStep(page, "Up again, now on the first line, recalls and stashes both lines.");
      await composer.press("ArrowUp");
      await expect(composer).toHaveValue(SENT.newest);
      await keyCastBeat(page);
      await composer.press("ArrowDown");
      await expect(composer).toHaveValue("first line\nsecond line");
      await keyCastBeat(page);

      await keyCastStep(page, "Modified arrows are left alone: Cmd+Up does not recall.");
      await composer.fill("");
      await composer.press("Meta+ArrowUp");
      await expect(composer).toHaveValue("");
      await keyCastBeat(page);

      await keyCastStep(page, "Recall never sent anything on its own.");
      await keyCastBeat(page, 1_500);
    } finally {
      await agent.cleanup();
    }
  });
});
