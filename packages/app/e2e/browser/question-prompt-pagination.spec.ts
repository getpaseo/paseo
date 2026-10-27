import { fork } from "node:child_process";
import path from "node:path";
import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { test } from "../support/fixtures";
import { expectVisibleAgentSurfacesIdle } from "../support/helpers/agent-stream";
import { buildSeededHost } from "../support/helpers/daemon-registry";
import { killProcessTree } from "../support/helpers/spawn-node";
import {
  buildAgentRoute,
  openAgentRoute,
  seedMockAgentWorkspace,
} from "../support/helpers/mock-agent";
import {
  chooseQuestionOption,
  continueToNextQuestion,
  expectCurrentQuestion,
  expectQuestionDismissEnabled,
  expectQuestionHidden,
  expectQuestionNavigationEnabled,
  expectQuestionOptionPreview,
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
const LINKED_QUESTION = "Sign in at https://example.com/login, then follow the setup guide. Done?";

function selectedText(page: Page) {
  return page.evaluate(() => window.getSelection()?.toString().trim());
}

const CHECKS_QUESTION = "Which checks should run?";
const DONE_DESCRIPTION = "Logs are at https://example.com/logs if sign-in fails.";
const LINT_DESCRIPTION = "Rules: https://example.com/lint";

async function openLinkedQuestions(page: Page, context: BrowserContext) {
  await context.route("https://example.com/**", (route) =>
    route.fulfill({ status: 200, body: "ok" }),
  );
  const session = await seedMockAgentWorkspace({
    repoPrefix: "question-option-links-",
    title: "Question option links e2e",
    initialPrompt: "Emit synthetic questions with links.",
  });
  await openAgentRoute(page, session);
  await waitForQuestionPrompt(page, 120_000);
  return { session, card: page.getByTestId("question-form-card").first() };
}

async function dragAcross(page: Page, target: Locator) {
  const bounds = await target.boundingBox();
  if (!bounds) throw new Error("Text is not visible");
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 1, y, { steps: 12 });
  await page.mouse.up();
}

async function clickLinkAndExpectPage(context: BrowserContext, link: Locator, url: string) {
  const popup = context.waitForEvent("page");
  await link.click();
  await expect.poll(async () => (await popup).url()).toBe(url);
}

async function expectChecked(option: Locator, checked: boolean) {
  await expect(option).toHaveAttribute("aria-checked", String(checked));
}

test.describe("Question option text", () => {
  test("links in an option label or description open without answering", async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);
    const { session, card } = await openLinkedQuestions(page, context);
    try {
      const done = card.getByRole("radio", { name: "Done" });
      const notYet = card.getByRole("radio", { name: "Not yet" });

      await clickLinkAndExpectPage(
        context,
        notYet.getByRole("link", { name: "status" }),
        "https://example.com/status",
      );
      await clickLinkAndExpectPage(
        context,
        done.getByRole("link", { name: "https://example.com/logs" }),
        "https://example.com/logs",
      );

      await expectCurrentQuestion(page, { index: 1, total: 2, question: LINKED_QUESTION });
      await expectChecked(done, false);
      await expectChecked(notYet, false);
    } finally {
      await session.cleanup();
    }
  });

  test("selecting description text never answers, and the label still does", async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);
    const { session, card } = await openLinkedQuestions(page, context);
    try {
      const done = card.getByRole("radio", { name: "Done" });
      const description = done.getByTestId("question-form-option-description");

      await dragAcross(page, description);
      await expect.poll(() => selectedText(page)).toBe(DONE_DESCRIPTION);
      await expectChecked(done, false);

      await description.getByText("Logs are at", { exact: false }).dblclick({
        position: { x: 4, y: 4 },
      });
      await expect.poll(() => selectedText(page)).toBe("Logs");
      await expectCurrentQuestion(page, { index: 1, total: 2, question: LINKED_QUESTION });
      await expectChecked(done, false);

      await done.getByText("Done", { exact: true }).click();
      await expectCurrentQuestion(page, { index: 2, total: 2, question: CHECKS_QUESTION });
      await openQuestion(page, { index: 1, total: 2 });
      await expectChecked(done, true);
    } finally {
      await session.cleanup();
    }
  });

  test("double-clicking a single-select label answers once", async ({ page, context }) => {
    test.setTimeout(180_000);
    const { session, card } = await openLinkedQuestions(page, context);
    try {
      await card.getByRole("radio", { name: "Done" }).getByText("Done", { exact: true }).dblclick();

      await expectCurrentQuestion(page, { index: 2, total: 2, question: CHECKS_QUESTION });
      await expectChecked(card.getByRole("checkbox", { name: "Lint" }), false);
      await expectChecked(card.getByRole("checkbox", { name: "Typecheck" }), false);
      await openQuestion(page, { index: 1, total: 2 });
      await expectChecked(card.getByRole("radio", { name: "Done" }), true);
    } finally {
      await session.cleanup();
    }
  });

  test("multi-select description links and selection leave the option unchanged", async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);
    const { session, card } = await openLinkedQuestions(page, context);
    try {
      await card.getByRole("radio", { name: "Done" }).getByText("Done", { exact: true }).click();
      await expectCurrentQuestion(page, { index: 2, total: 2, question: CHECKS_QUESTION });

      const lint = card.getByRole("checkbox", { name: "Lint" });
      const typecheck = card.getByRole("checkbox", { name: "Typecheck" });
      const description = lint.getByTestId("question-form-option-description");

      await clickLinkAndExpectPage(
        context,
        description.getByRole("link", { name: "https://example.com/lint" }),
        "https://example.com/lint",
      );
      await expectChecked(lint, false);

      await dragAcross(page, description);
      await expect.poll(() => selectedText(page)).toBe(LINT_DESCRIPTION);
      await expectChecked(lint, false);

      await description.getByText("Rules:", { exact: false }).dblclick({
        position: { x: 4, y: 4 },
      });
      await expect.poll(() => selectedText(page)).toBe("Rules");
      await expectChecked(lint, false);

      await typecheck.getByText("Typecheck", { exact: true }).dblclick();
      await expectChecked(typecheck, true);
      await lint.getByText("Lint", { exact: true }).click();
      await expectChecked(lint, true);
    } finally {
      await session.cleanup();
    }
  });
});

test.describe("Question prompt pagination", () => {
  test("question links open without answering, and the question text is selectable", async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);
    await context.route("https://example.com/**", (route) =>
      route.fulfill({ status: 200, body: "ok" }),
    );

    const session = await seedMockAgentWorkspace({
      repoPrefix: "question-links-",
      title: "Question links e2e",
      initialPrompt: "Emit synthetic questions with links.",
    });

    try {
      await openAgentRoute(page, session);
      await waitForQuestionPrompt(page, 120_000);

      const card = page.getByTestId("question-form-card").first();
      const question = card.getByTestId("question-form-current-question");
      await expect(question).toHaveText(LINKED_QUESTION);
      await expect(question.getByRole("link", { name: "https://example.com/login" })).toBeVisible();
      await expect(question.getByRole("link", { name: "the setup guide" })).toBeVisible();

      const bounds = await question.boundingBox();
      if (!bounds) throw new Error("Question text is not visible");
      const y = bounds.y + bounds.height / 2;
      await page.mouse.move(bounds.x + 1, y);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width - 1, y, { steps: 12 });
      await page.mouse.up();
      await expect.poll(() => selectedText(page)).toBe(LINKED_QUESTION);

      const popup = context.waitForEvent("page");
      await question.getByRole("link", { name: "the setup guide" }).click();
      await expect.poll(async () => (await popup).url()).toBe("https://example.com/setup");

      await expect(page.getByTestId("question-form-card")).toHaveCount(1);
      for (const option of ["Done", "Not yet"]) {
        await expect(card.getByRole("radio", { name: option })).toHaveAttribute(
          "aria-checked",
          "false",
        );
      }
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
      await expectQuestionOptionPreview(page, {
        option: "Behind feature flag",
        preview: 'flags.enabled("new-surface")',
      });
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

const questionDaemonMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), port: z.number(), serverId: z.string() }),
  z.object({
    type: z.literal("attempt"),
    requestId: z.string(),
    response: z.unknown(),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal("resolved"),
    requestId: z.string(),
    response: z.unknown(),
    sessionId: z.string(),
    pendingRequestIds: z.array(z.string()),
  }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);

type QuestionResponseAttempt = Extract<z.infer<typeof questionDaemonMessage>, { type: "attempt" }>;

type QuestionResolution = Extract<z.infer<typeof questionDaemonMessage>, { type: "resolved" }>;

interface QuestionRetryControl {
  attempts: QuestionResponseAttempt[];
  resolutions: QuestionResolution[];
  releaseFirstResponse(): void;
}

const retryTest = test.extend<{
  questionClient: QuestionRetryControl;
}>({
  questionClient: async ({ page }, provide, testInfo) => {
    const serverDir = path.resolve(__dirname, "../../../server");
    const child = fork(path.join(serverDir, "src/server/test-utils/question-response-daemon.ts"), {
      cwd: serverDir,
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const output: string[] = [];
    child.stdout?.on("data", (data: Buffer) => output.push(data.toString()));
    child.stderr?.on("data", (data: Buffer) => output.push(data.toString()));
    const ready = Promise.withResolvers<{ port: number; serverId: string }>();
    const attempts: QuestionResponseAttempt[] = [];
    const resolutions: QuestionResolution[] = [];
    child.on("message", (message: unknown) => {
      const parsed = questionDaemonMessage.parse(message);
      switch (parsed.type) {
        case "ready":
          ready.resolve(parsed);
          break;
        case "attempt":
          attempts.push(parsed);
          break;
        case "resolved":
          resolutions.push(parsed);
          break;
        case "error":
          ready.reject(new Error(parsed.error));
          break;
      }
    });
    child.once("exit", (code) => ready.reject(new Error(`Question daemon exited with ${code}`)));
    const timeout = setTimeout(
      () => ready.reject(new Error("Question daemon startup timed out")),
      20_000,
    );
    try {
      const daemon = await ready.promise;
      clearTimeout(timeout);
      const session = await seedMockAgentWorkspace({
        port: daemon.port,
        repoPrefix: "question-retry-",
        title: "Question response retry",
        initialPrompt: "Emit synthetic questions.",
      });
      try {
        await page.goto("/", { waitUntil: "commit" });
        const serverId = daemon.serverId;
        const host = buildSeededHost({
          serverId,
          endpoint: `127.0.0.1:${daemon.port}`,
          label: "Question retry host",
          nowIso: new Date().toISOString(),
        });
        await page.evaluate((extraHost) => {
          localStorage.setItem("@paseo:e2e-extra-hosts", JSON.stringify([extraHost]));
        }, host);
        await page.goto(buildAgentRoute(session.workspaceId, session.agentId, serverId), {
          waitUntil: "commit",
        });
        await waitForQuestionPrompt(page, 120_000);
        await provide({ attempts, resolutions, releaseFirstResponse: () => child.send("release") });
      } finally {
        await session.cleanup();
      }
    } finally {
      clearTimeout(timeout);
      await killProcessTree(child);
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("question-daemon", {
          body: output.join(""),
          contentType: "text/plain",
        });
      }
    }
  },
});

retryTest(
  "failed question submission preserves answers and allows retry",
  async ({ page, questionClient }, testInfo) => {
    retryTest.setTimeout(180_000);
    const card = page.getByTestId("question-form-card");
    await chooseQuestionOption(page, "App");
    await chooseQuestionOption(page, "Behind feature flag");
    await fillQuestionAnswer(page, {
      question: SUCCESS_QUESTION,
      answer: "Preserve my answers after a failed submission.",
    });
    await card.getByRole("button", { name: "Submit" }).click();
    await expect(card.getByRole("progressbar")).toBeVisible();
    await expectQuestionPrimaryActionDisabled(page, "Submit");
    await expect(card.getByRole("button", { name: "Dismiss" })).toBeDisabled();
    await expect(card.getByRole("tab").first()).toBeDisabled();
    await expect(card.getByRole("textbox")).not.toBeEditable();
    questionClient.releaseFirstResponse();
    await expectQuestionPrimaryActionEnabled(page, "Submit");
    await card.screenshot({ path: testInfo.outputPath("submission-failed.png") });
    await expect(card.getByRole("alert")).toHaveText("Could not send your response. Try again.");
    await expect(card.getByRole("progressbar")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Submit" })).toHaveText("Submit");
    await expectQuestionDismissEnabled(page);
    await openQuestion(page, { index: 1, total: TOTAL_QUESTIONS });
    await expectQuestionOptionSelected(page, "App");
    await openQuestion(page, { index: 2, total: TOTAL_QUESTIONS });
    await expectQuestionOptionSelected(page, "Behind feature flag");
    await openQuestion(page, { index: 3, total: TOTAL_QUESTIONS });
    await expect(card.getByRole("textbox")).toHaveValue(
      "Preserve my answers after a failed submission.",
    );
    await submitQuestionAnswers(page);
    await expectVisibleAgentSurfacesIdle(page);
    await expect.poll(() => questionClient.attempts.length).toBe(2);
    expect(questionClient.attempts[1]).toEqual(questionClient.attempts[0]);
    await expect
      .poll(() => questionClient.resolutions)
      .toEqual([{ ...questionClient.attempts[1], type: "resolved", pendingRequestIds: [] }]);
    expect(questionClient.attempts[1].response).toMatchObject({
      behavior: "allow",
      updatedInput: {
        answers: {
          surface: "App",
          rollout: "Behind feature flag",
          success: "Preserve my answers after a failed submission.",
        },
      },
    });
    await page.screenshot({ path: testInfo.outputPath("submission-retried.png") });
  },
);

retryTest(
  "failed question dismissal allows an immediate retry",
  async ({ page, questionClient }, testInfo) => {
    retryTest.setTimeout(180_000);
    const card = page.getByTestId("question-form-card");
    questionClient.releaseFirstResponse();
    await chooseQuestionOption(page, "App");
    await chooseQuestionOption(page, "Behind feature flag");
    await fillQuestionAnswer(page, {
      question: SUCCESS_QUESTION,
      answer: "Start with the internal team.",
    });
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card.getByRole("alert")).toHaveText("Could not send your response. Try again.");
    await expect(card.getByRole("progressbar")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Dismiss" })).toHaveText("Dismiss");
    await expectQuestionDismissEnabled(page);
    await expectQuestionPrimaryActionEnabled(page, "Submit");
    await card.screenshot({ path: testInfo.outputPath("dismissal-failed.png") });
    await openQuestion(page, { index: 1, total: TOTAL_QUESTIONS });
    await expectQuestionOptionSelected(page, "App");
    await openQuestion(page, { index: 3, total: TOTAL_QUESTIONS });
    await expect(card.getByRole("textbox")).toHaveValue("Start with the internal team.");
    await expect(card.getByRole("alert")).toBeVisible();
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card).toHaveCount(0);
    await expectVisibleAgentSurfacesIdle(page);
    await expect.poll(() => questionClient.attempts.length).toBe(2);
    expect(questionClient.attempts[1]).toEqual(questionClient.attempts[0]);
    await expect
      .poll(() => questionClient.resolutions)
      .toEqual([{ ...questionClient.attempts[1], type: "resolved", pendingRequestIds: [] }]);
    expect(questionClient.attempts[1].response).toEqual({
      behavior: "deny",
      message: "Dismissed by user",
    });
    await page.screenshot({ path: testInfo.outputPath("dismissal-retried.png") });
  },
);
