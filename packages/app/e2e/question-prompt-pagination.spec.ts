import { test } from "./fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";
import {
  chooseQuestionOption,
  expectCurrentQuestion,
  expectQuestionHidden,
  expectQuestionOptionSelected,
  fillQuestionAnswer,
  openQuestion,
  submitQuestionAnswers,
  waitForQuestionPrompt,
} from "./helpers/questions";

const TOTAL_QUESTIONS = 3;
const SURFACE_QUESTION = "Which surface should this apply to?";
const ROLLOUT_QUESTION = "Which rollout should we use?";
const SUCCESS_QUESTION = "What success criteria should we use?";

test.describe("Question prompt pagination", () => {
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
});
