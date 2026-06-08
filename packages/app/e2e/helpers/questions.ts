import { expect, type Page } from "@playwright/test";

export async function waitForQuestionPrompt(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.getByTestId("question-form-card").first()).toBeVisible({ timeout });
}

export async function expectCurrentQuestion(
  page: Page,
  input: { index: number; total: number; question: string },
): Promise<void> {
  const card = page.getByTestId("question-form-card").first();
  await expect(card.getByTestId("question-form-current-question")).toHaveText(input.question);
  await expect(
    card.getByRole("button", { name: `Question ${input.index} of ${input.total}` }),
  ).toHaveAttribute("aria-selected", "true");
}

export async function expectQuestionHidden(page: Page, question: string): Promise<void> {
  await expect(page.getByText(question, { exact: true })).toHaveCount(0);
}

export async function chooseQuestionOption(page: Page, option: string): Promise<void> {
  await page
    .getByTestId("question-form-card")
    .first()
    .getByRole("button", { name: option })
    .click();
}

export async function expectQuestionOptionSelected(page: Page, option: string): Promise<void> {
  await expect(
    page.getByTestId("question-form-card").first().getByRole("button", { name: option }),
  ).toHaveAttribute("aria-selected", "true");
}

export async function openQuestion(
  page: Page,
  input: { index: number; total: number },
): Promise<void> {
  await page
    .getByTestId("question-form-card")
    .first()
    .getByRole("button", { name: `Question ${input.index} of ${input.total}` })
    .click();
}

export async function fillQuestionAnswer(
  page: Page,
  input: { question: string; answer: string },
): Promise<void> {
  await page
    .getByTestId("question-form-card")
    .first()
    .getByRole("textbox", { name: input.question })
    .fill(input.answer);
}

export async function submitQuestionAnswers(page: Page): Promise<void> {
  await page.getByTestId("question-form-primary-action").click();
  await expect(page.getByTestId("question-form-card")).toHaveCount(0, { timeout: 30_000 });
}
