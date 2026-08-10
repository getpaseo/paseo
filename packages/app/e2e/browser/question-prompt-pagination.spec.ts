import { expect, test } from "../support/fixtures";
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

test.describe("Question prompt pagination", () => {
  test("links and selects question content", async ({ page }) => {
    test.setTimeout(180_000);

    const session = await seedMockAgentWorkspace({
      repoPrefix: "question-linked-content-",
      title: "Question linked content e2e",
      initialPrompt: "Emit synthetic questions with linked content.",
    });

    try {
      await openAgentRoute(page, session);
      await waitForQuestionPrompt(page, 120_000);

      const card = page.getByTestId("question-form-card").first();
      const docsLink = card.locator('a[href="https://example.com/docs"]');
      const fileLink = card.locator('a[href="packages/app/src/components/question-form-card.tsx"]');
      const referenceLink = card.locator('a[href="https://example.com/reference"]');
      await expect(docsLink).toHaveText("the docs");
      await expect(fileLink).toHaveText("packages/app/src/components/question-form-card.tsx");
      await expect(referenceLink).toHaveText("https://example.com/reference");

      const description = card.getByTestId("question-form-option-description-0-0");
      await expect(description).toHaveCSS("user-select", "text");
      await expect(description.locator("span").first()).toHaveCSS("font-size", "14px");
      const selectedText = await description.evaluate((element) => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection?.removeAllRanges();
        selection?.addRange(range);
        return selection?.toString();
      });
      expect(selectedText?.replace(/\s+/g, " ")).toBe(
        "Compare https://example.com/reference first.",
      );

      const firstOption = card.getByRole("radio").first();
      const secondOption = card.getByRole("radio").nth(1);
      await secondOption.click();
      await expect(secondOption).toHaveAttribute("aria-checked", "true");
      await secondOption.click();
      await expect(secondOption).toHaveAttribute("aria-checked", "false");

      await fileLink.click();
      await expect(firstOption).toHaveAttribute("aria-checked", "false");
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
