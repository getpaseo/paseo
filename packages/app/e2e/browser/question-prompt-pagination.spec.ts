import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  chooseQuestionOption,
  continueToNextQuestion,
  expectCurrentQuestion,
  expectQuestionDismissEnabled,
  expectQuestionHidden,
  expectQuestionNavigationEnabled,
  expectQuestionOptionSelected,
  expectQuestionPrimaryActionDisabled,
  expectQuestionPrimaryActionEnabled,
  fillQuestionAnswer,
  openQuestion,
  submitQuestionAnswers,
  waitForQuestionPrompt,
} from "../support/helpers/questions";

const TOTAL_QUESTIONS = 3;
const SURFACE_QUESTION = "Which surface should this apply to?";
const ROLLOUT_QUESTION = "Which rollout should we use?";
const SUCCESS_QUESTION = "What success criteria should we use?";
const REPO_URL_QUESTION = "What is the GitHub private repo URL to push to?";
const COMMIT_MESSAGE_QUESTION = "What should the first commit message be?";

function selectedText(page: Page) {
  return page.evaluate(() => window.getSelection()?.toString());
}

function clipboardText(page: Page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe("Question prompt pagination", () => {
  test("copies question text without selecting an answer or advancing", async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    const session = await seedMockAgentWorkspace({
      repoPrefix: "question-selection-",
      title: "Question text selection e2e",
      initialPrompt: "Emit synthetic questions.",
    });

    try {
      await openAgentRoute(page, session);
      await waitForQuestionPrompt(page, 120_000);

      const card = page.getByTestId("question-form-card").first();
      const question = card.getByTestId("question-form-current-question");
      await expect(question).toHaveText(SURFACE_QUESTION);
      await question.scrollIntoViewIfNeeded();
      const bounds = await question.boundingBox();
      if (!bounds) throw new Error("Question text is not visible");

      const y = bounds.y + bounds.height / 2;
      await page.mouse.move(bounds.x + 1, y);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width - 1, y, { steps: 12 });
      await page.mouse.up();
      await expect.poll(() => selectedText(page)).toBe(SURFACE_QUESTION);
      await page.keyboard.press("ControlOrMeta+C");
      await expect.poll(() => clipboardText(page)).toBe(SURFACE_QUESTION);

      await question.dblclick({ position: { x: 10, y: bounds.height / 2 } });
      await expect.poll(() => selectedText(page)).toBe("Which");
      await page.keyboard.press("ControlOrMeta+C");
      await expect.poll(() => clipboardText(page)).toBe("Which");

      await expectCurrentQuestion(page, {
        index: 1,
        total: TOTAL_QUESTIONS,
        question: SURFACE_QUESTION,
      });
      await expect(card.getByRole("radio", { name: "App", exact: true })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await expect(card.getByRole("radio", { name: "Desktop", exact: true })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await expectQuestionPrimaryActionDisabled(page, "Next");

      await chooseQuestionOption(page, "App");
      await expectCurrentQuestion(page, {
        index: 2,
        total: TOTAL_QUESTIONS,
        question: ROLLOUT_QUESTION,
      });
    } finally {
      await session.cleanup();
    }
  });

  test("shows one question at a time with numbered navigation", async ({ page }) => {
    test.setTimeout(180_000);

    const session = await seedMockAgentWorkspace({
      repoPrefix: "question-pagination-",
      title: "Question pagination e2e",
      initialPrompt: "Emit synthetic questions.",
    });

    try {
      await openAgentRoute(page, session);
      await waitForQuestionPrompt(page, 120_000);

      await expectCurrentQuestion(page, {
        index: 1,
        total: TOTAL_QUESTIONS,
        question: SURFACE_QUESTION,
      });
      await expectQuestionHidden(page, ROLLOUT_QUESTION);
      await expectQuestionHidden(page, SUCCESS_QUESTION);

      await chooseQuestionOption(page, "App");
      await expectCurrentQuestion(page, {
        index: 2,
        total: TOTAL_QUESTIONS,
        question: ROLLOUT_QUESTION,
      });

      await openQuestion(page, { index: 1, total: TOTAL_QUESTIONS });
      await expectCurrentQuestion(page, {
        index: 1,
        total: TOTAL_QUESTIONS,
        question: SURFACE_QUESTION,
      });
      await expectQuestionOptionSelected(page, "App");

      await openQuestion(page, { index: 2, total: TOTAL_QUESTIONS });
      await chooseQuestionOption(page, "Behind feature flag");
      await expectCurrentQuestion(page, {
        index: 3,
        total: TOTAL_QUESTIONS,
        question: SUCCESS_QUESTION,
      });

      await fillQuestionAnswer(page, {
        question: SUCCESS_QUESTION,
        answer: "Only one prompt is visible at a time.",
      });
      await submitQuestionAnswers(page);
    } finally {
      await session.cleanup();
    }
  });

  test("free-write questions use Next before final Submit", async ({ page }) => {
    test.setTimeout(180_000);

    const session = await seedMockAgentWorkspace({
      repoPrefix: "question-free-write-",
      title: "Question free-write e2e",
      initialPrompt: "Emit synthetic questions: two free-write questions.",
    });

    try {
      await openAgentRoute(page, session);
      await waitForQuestionPrompt(page, 120_000);

      await expectCurrentQuestion(page, {
        index: 1,
        total: 2,
        question: REPO_URL_QUESTION,
      });

      await fillQuestionAnswer(page, {
        question: REPO_URL_QUESTION,
        answer: "git@github.com:user/private-repo.git",
      });

      await expectQuestionPrimaryActionEnabled(page, "Next");
      await expectQuestionDismissEnabled(page);
      await expectQuestionNavigationEnabled(page, { index: 2, total: 2 });

      await continueToNextQuestion(page);
      await expectCurrentQuestion(page, {
        index: 2,
        total: 2,
        question: COMMIT_MESSAGE_QUESTION,
      });
      await expectQuestionPrimaryActionDisabled(page, "Submit");

      await fillQuestionAnswer(page, {
        question: COMMIT_MESSAGE_QUESTION,
        answer: "Initialize private repo",
      });
      await expectQuestionPrimaryActionEnabled(page, "Submit");
      await submitQuestionAnswers(page);
    } finally {
      await session.cleanup();
    }
  });
});
