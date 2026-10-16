import { fork } from "node:child_process";
import path from "node:path";
import { expect } from "@playwright/test";
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
