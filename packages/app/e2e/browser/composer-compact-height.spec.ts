import { expect, test } from "../support/fixtures";
import { expectAgentIdle } from "../support/helpers/agent-stream";
import {
  composerLocator,
  expectComposerVisible,
  fillComposerDraft,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const COMPACT_VIEWPORT = { width: 390, height: 844 } as const;
/** Keep in lockstep with `COMPOSER_INPUT_LINE_HEIGHT * COMPACT_MAX_INPUT_LINES`. */
const TEN_LINE_CAP = 210;
const INITIAL_PROMPT = "emit 1 coalesced agent stream updates for compact composer height.";
const LONG_DRAFT = Array.from(
  { length: 40 },
  (_, index) => `composer height cap line ${index + 1}`,
).join("\n");

test.use({ viewport: COMPACT_VIEWPORT, isMobile: true, hasTouch: true });

test.describe("Compact composer height", () => {
  test("caps a long draft at 10 lines so the timeline stays on screen", async ({ page }) => {
    test.setTimeout(90_000);
    const session = await seedMockAgentWorkspace({
      repoPrefix: "composer-compact-height-",
      title: "Compact composer height",
      initialPrompt: INITIAL_PROMPT,
    });

    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      const timelineReply = page.getByText("stress-update-0", { exact: true }).first();
      await expect(timelineReply).toBeVisible({ timeout: 30_000 });
      await expectAgentIdle(page);

      const input = composerLocator(page);
      await fillComposerDraft(page, LONG_DRAFT);

      await expect
        .poll(async () => {
          const box = await input.boundingBox();
          return box?.height ?? 0;
        })
        .toBeGreaterThan(TEN_LINE_CAP * 0.5);

      const inputBox = await input.boundingBox();
      const composerBox = await page.getByTestId("message-input-root").boundingBox();
      const replyBox = await timelineReply.boundingBox();
      expect(inputBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(replyBox).not.toBeNull();

      expect(inputBox!.height).toBeLessThanOrEqual(TEN_LINE_CAP + 2);
      expect(composerBox!.height).toBeLessThan(COMPACT_VIEWPORT.height * 0.45);
      expect(replyBox!.y).toBeGreaterThanOrEqual(0);
      expect(replyBox!.y + 8).toBeLessThan(composerBox!.y);

      const overflow = await input.evaluate((element) => {
        if (!(element instanceof HTMLTextAreaElement)) {
          throw new Error("Composer input did not render as a textarea");
        }
        return element.scrollHeight - element.clientHeight;
      });
      expect(overflow).toBeGreaterThan(50);
    } finally {
      await session.cleanup();
    }
  });
});
