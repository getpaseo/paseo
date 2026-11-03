import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { waitForQuestionPrompt } from "../support/helpers/questions";

/**
 * The question text an agent hard-wraps before sending it.
 *
 * The app-wide markdown flags render a soft break as a hard break, so a card
 * that does not fold them back stacks every token on its own row. The agent
 * behind this is the one that asks through the question form with wrapped
 * text; the same shape arrives from a Z.ai or ZCode provider that wraps its
 * question at a column.
 *
 * The folded text keeps the breaks as spaces, which is what Markdown does
 * with a soft break inside a code span too.
 */
const WRAPPED_QUESTION =
  "确认：zcode -credentials .ts 只在 PR #8343 （feat /zai -coding -plan -quota ）里";
const WRAPPED_OPTION = "确认 先合并 PR";
const WRAPPED_OPTION_DESCRIPTION = "先合并 PR #8343 再重跑";

/** The rendered text of an element, with the whitespace the browser produced. */
async function renderedText(page: Page, testId: string): Promise<string> {
  return page.getByTestId(testId).first().innerText();
}

test.describe("question card soft breaks", () => {
  test("wrapped question text reads as sentences instead of one token per row", async ({
    page,
  }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "question-wrapped-text-",
      title: "Question wrapped text e2e",
      initialPrompt: "Emit synthetic questions with wrapped text.",
    });
    try {
      await openAgentRoute(page, session);
      await waitForQuestionPrompt(page, 120_000);

      const card = page.getByTestId("question-form-card").first();
      await expect(card).toBeVisible({ timeout: 30_000 });

      // The question text is one line of prose, not a column of fragments.
      const question = await renderedText(page, "question-form-current-question");
      expect(question.replace(/\s+/g, " ").trim()).toBe(WRAPPED_QUESTION);
      // A break that survived would show up as more than one rendered line.
      expect(question.split("\n").filter((line) => line.trim().length > 0)).toHaveLength(1);

      // The same holds for the option label and its description.
      const option = card
        .getByRole("radio", { name: WRAPPED_OPTION })
        .or(card.getByRole("checkbox", { name: WRAPPED_OPTION }));
      await expect(option).toBeVisible();
      const optionText = await option.innerText();
      expect(optionText.replace(/\s+/g, " ").trim()).toBe(
        `${WRAPPED_OPTION} ${WRAPPED_OPTION_DESCRIPTION}`,
      );
      // The label reads as one line, and so does the description. A break that
      // survived would show up as more than one rendered line.
      const optionLines = optionText.split("\n").filter((line) => line.trim().length > 0);
      expect(optionLines).toHaveLength(2);

      await page.screenshot({
        path: "test-results/question-card-wrapped-text.png",
        fullPage: false,
      });
    } finally {
      await session.cleanup();
    }
  });
});
