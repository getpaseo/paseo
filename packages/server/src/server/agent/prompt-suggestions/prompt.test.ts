import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { buildPromptSuggestionPrompt, buildQuestionAnswerPrompt } from "./prompt.js";
import { normalizeQuestionAnswers, normalizeSuggestions } from "./types.js";

function userMessage(text: string): AgentTimelineItem {
  return { type: "user_message", text };
}

function assistantMessage(text: string): AgentTimelineItem {
  return { type: "assistant_message", text };
}

describe("buildPromptSuggestionPrompt", () => {
  it("returns null when there is no conversation to guess from", async () => {
    expect(await buildPromptSuggestionPrompt({ timeline: [] })).toBeNull();
    expect(await buildPromptSuggestionPrompt({ timeline: [userMessage("   ")] })).toBeNull();
  });

  it("includes the conversation, the agent title and the working directory", async () => {
    const built = await buildPromptSuggestionPrompt({
      timeline: [userMessage("fix the login test"), assistantMessage("Fixed auth.test.ts")],
      agentTitle: "Login fix",
      cwd: "/repo/app",
    });

    expect(built).not.toBeNull();
    expect(built?.prompt).toContain("[User] fix the login test");
    expect(built?.prompt).toContain("[Assistant] Fixed auth.test.ts");
    expect(built?.prompt).toContain("Agent: Login fix");
    expect(built?.prompt).toContain("Working directory: /repo/app");
    expect(built?.truncated).toBe(false);
  });

  it("keeps the tail and cuts on a line boundary when the transcript is long", async () => {
    const timeline: AgentTimelineItem[] = [];
    for (let i = 0; i < 200; i += 1) {
      timeline.push(userMessage(`old request ${i} ${"x".repeat(80)}`));
      timeline.push(assistantMessage(`old reply ${i} ${"y".repeat(80)}`));
    }
    timeline.push(userMessage("the newest request"));

    const built = await buildPromptSuggestionPrompt({
      timeline,
      maxContextChars: 600,
    });

    expect(built?.truncated).toBe(true);
    expect(built?.contextChars).toBeLessThanOrEqual(600);
    expect(built?.prompt).toContain("[User] the newest request");
    expect(built?.prompt).not.toContain("old request 0 ");
    const conversation = built?.prompt.split("<conversation>\n")[1]?.split("\n</conversation>")[0];
    expect(conversation?.startsWith("[")).toBe(true);
  });

  it("keeps every tool item out of the prompt, inputs, summaries and sub-agent logs alike", async () => {
    const built = await buildPromptSuggestionPrompt({
      timeline: [
        userMessage("run the suite"),
        {
          type: "tool_call",
          callId: "t1",
          name: "Bash",
          status: "completed",
          detail: {
            type: "shell",
            command: "TOKEN=SYNTHETIC_SECRET curl https://example.invalid",
            output: "",
            exitCode: 0,
          },
        } as AgentTimelineItem,
        {
          type: "tool_call",
          callId: "t2",
          name: "Task",
          status: "completed",
          detail: { type: "sub_agent", log: "file contents: SYNTHETIC_FILE_SECRET" },
        } as AgentTimelineItem,
        assistantMessage("3 tests failed"),
      ],
    });

    expect(built?.prompt).not.toContain("SYNTHETIC_SECRET");
    expect(built?.prompt).not.toContain("SYNTHETIC_FILE_SECRET");
    expect(built?.prompt).not.toContain("curl");
    expect(built?.prompt).toContain("[Assistant] 3 tests failed");
  });

  it("lets paseo.json replace the style rules without losing the contract", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "paseo-suggestions-"));
    writeFileSync(
      join(repoRoot, "paseo.json"),
      JSON.stringify({
        metadataGeneration: { promptSuggestions: { instructions: "Suggest in Romanian only." } },
      }),
    );
    const workspaceGitService = { resolveRepoRoot: async () => repoRoot };

    const built = await buildPromptSuggestionPrompt({
      timeline: [userMessage("fix the login test")],
      cwd: repoRoot,
      workspaceGitService,
    });

    expect(built?.prompt).toContain("Suggest in Romanian only.");
    expect(built?.prompt).not.toContain("Write as the developer");
    expect(built?.prompt).toContain("You predict what a developer will type next");
    expect(built?.prompt).toContain('Return JSON only: {"suggestions"');
  });

  it("keeps the built-in rules when the repo says nothing", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "paseo-suggestions-"));
    const built = await buildPromptSuggestionPrompt({
      timeline: [userMessage("fix the login test")],
      cwd: repoRoot,
      workspaceGitService: { resolveRepoRoot: async () => repoRoot },
    });

    expect(built?.prompt).toContain("Write as the developer");
  });
});

describe("normalizeSuggestions", () => {
  it("strips list markers and surrounding quotes", () => {
    expect(normalizeSuggestions(['1. "run the tests"', "- open a PR"])).toEqual([
      { id: "s1", text: "run the tests" },
      { id: "s2", text: "open a PR" },
    ]);
  });

  it("drops blanks and case-insensitive duplicates, and caps the count", () => {
    expect(
      normalizeSuggestions(["Run the tests", "   ", "run the tests", "open a PR", "ship it", "и"]),
    ).toEqual([
      { id: "s1", text: "Run the tests" },
      { id: "s2", text: "open a PR" },
      { id: "s3", text: "ship it" },
    ]);
  });

  it("clips an over-long suggestion at a word boundary instead of dropping it", () => {
    const [only] = normalizeSuggestions([`${"word ".repeat(60)}end`]);

    expect(only.text.length).toBeLessThanOrEqual(160);
    expect(only.text.endsWith("…")).toBe(true);
    expect(only.text).toContain("word word");
  });
});

describe("buildQuestionAnswerPrompt", () => {
  const question = (text: string, options: string[] = [], allowOther = false) => ({
    question: text,
    header: text,
    options: options.map((label) => ({ label })),
    multiSelect: false,
    allowOther,
    allowEmpty: false,
  });

  it("numbers each answerable question by its place on the card", async () => {
    const built = await buildQuestionAnswerPrompt({
      timeline: [userMessage("set up the worker")],
      questions: [
        question("Ship today?", ["Yes", "No"]),
        question("Which database?"),
        question("Which region?", ["eu-west-1"], true),
      ],
    });

    expect(built?.prompt).not.toContain("Ship today?");
    expect(built?.prompt).toContain("Question 2: Which database?");
    expect(built?.prompt).toContain("Question 3: Which region?");
    expect(built?.prompt).toContain('{"answers": [{"question": 1');
    expect([...(built?.answerable ?? [])]).toEqual([
      [2, 1],
      [3, 2],
    ]);
  });

  it("returns null when no question takes typed text", async () => {
    const built = await buildQuestionAnswerPrompt({
      timeline: [userMessage("set up the worker")],
      questions: [question("Ship today?", ["Yes", "No"])],
    });

    expect(built).toBeNull();
  });
});

describe("normalizeQuestionAnswers", () => {
  const answerable = new Map([
    [1, 0],
    [3, 2],
  ]);

  it("tags each answer with its question and lets questions take turns under the cap", () => {
    expect(
      normalizeQuestionAnswers(
        [
          { question: 1, suggestions: ["Postgres", "SQLite", "MySQL"] },
          { question: 3, suggestions: ["eu-west-1", "us-east-1"] },
        ],
        answerable,
      ),
    ).toEqual([
      { id: "s1", text: "Postgres", questionIndex: 0 },
      { id: "s2", text: "eu-west-1", questionIndex: 2 },
      { id: "s3", text: "SQLite", questionIndex: 0 },
    ]);
  });

  it("drops answers filed under a number the prompt never gave", () => {
    expect(
      normalizeQuestionAnswers(
        [
          { question: 2, suggestions: ["Yes"] },
          { question: 0, suggestions: ["zero"] },
          { question: 3, suggestions: ["eu-west-1"] },
        ],
        answerable,
      ),
    ).toEqual([{ id: "s1", text: "eu-west-1", questionIndex: 2 }]);
  });

  it("merges a question listed twice and dedupes within it, not across questions", () => {
    expect(
      normalizeQuestionAnswers(
        [
          { question: 1, suggestions: ["Postgres"] },
          { question: 3, suggestions: ["postgres"] },
          { question: 1, suggestions: ["- POSTGRES", "SQLite"] },
        ],
        answerable,
      ),
    ).toEqual([
      { id: "s1", text: "Postgres", questionIndex: 0 },
      { id: "s2", text: "postgres", questionIndex: 2 },
      { id: "s3", text: "SQLite", questionIndex: 0 },
    ]);
  });
});
