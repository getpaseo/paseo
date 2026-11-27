import { describe, expect, test } from "vitest";
import {
  MAX_WORKER_BLOCKED_REASON_CHARS,
  NO_ANSWER_PREFIX,
  WORKER_BLOCKED_PREFIX,
  isNoAnswerFailure,
  isPendingRequestFailure,
  mentionsNoAnswer,
  isWorkerBlocked,
  needsPerson,
  personDecides,
  withoutWorkerStatus,
  workerBlockedFailureText,
  workerBlockedReason,
  workerStatus,
} from "./failure-wording.js";

// The end of t8's report in goal 4fe24f94 (seq 106): blocked in words, with no status line.
const T8_SUMMARY = [
  "I couldn't make any changes. Every Bash command is refused before it starts.",
  "",
  "Two existing problems will still be there:",
  "- **Lib tests:** t3 reported that the lib test target doesn't compile at the base commit.",
  "- **Cargo target:** the default musl target isn't installed here.",
  "",
  "Answer: Blocked by a full disk (ENOSPC). Free space or set `CLAUDE_CODE_TMPDIR`, and I'll implement the task.",
].join("\n");

describe("workerStatus", () => {
  test.each([
    ["t8's report, which has no status line", T8_SUMMARY, null],
    ["an empty message", "", null],
    ["a plain done line", "Changed a.ts.\nTASK_STATUS: done", { status: "done" }],
    ["done with a period", "Changed a.ts.\nTASK_STATUS: done.", { status: "done" }],
    [
      "a blocked line",
      "Nothing changed.\nTASK_STATUS: blocked: disk full",
      { status: "blocked", reason: "disk full" },
    ],
    [
      "the marker, then an Answer block after it",
      "Report.\nTASK_STATUS: blocked: disk full\n\nAnswer: Blocked by a full disk.",
      { status: "blocked", reason: "disk full" },
    ],
    [
      "an Answer block, then the marker",
      `${T8_SUMMARY}\n\nTASK_STATUS: blocked: ENOSPC on /tmp`,
      { status: "blocked", reason: "ENOSPC on /tmp" },
    ],
    ["a bold marker", "Done.\n**TASK_STATUS: done**", { status: "done" }],
    [
      "an italic blocked marker",
      "x\n*TASK_STATUS: blocked: no credentials*",
      { status: "blocked", reason: "no credentials" },
    ],
    ["a code-span marker", "x\n`TASK_STATUS: blocked: x`", { status: "blocked", reason: "x" }],
    ["a quoted marker", "x\n> TASK_STATUS: done", { status: "done" }],
    ["a fenced marker", "x\n```\nTASK_STATUS: done\n```", { status: "done" }],
    ["a marker with a fence line after", "x\nTASK_STATUS: done\n```", { status: "done" }],
    [
      "lower case and extra spaces",
      "x\n  task_status :   blocked :   the   API   key is missing  ",
      { status: "blocked", reason: "the API key is missing" },
    ],
    [
      "a dash before the reason",
      "x\nTASK_STATUS: blocked - service down",
      { status: "blocked", reason: "service down" },
    ],
    [
      "an em dash before the reason",
      "x\nTASK_STATUS: blocked — service down",
      { status: "blocked", reason: "service down" },
    ],
    [
      "blocked without a reason",
      "x\nTASK_STATUS: blocked",
      { status: "blocked", reason: "no reason given" },
    ],
    ["CRLF line endings", "x\r\nTASK_STATUS: done\r\n", { status: "done" }],
    [
      "two markers: the last one wins",
      "TASK_STATUS: blocked: earlier\nTASK_STATUS: done",
      { status: "done" },
    ],
    ["a marker earlier than the last 5 lines", "TASK_STATUS: blocked: quoted\n1\n2\n3\n4\n5", null],
    ["a marker inside a sentence", "x\nI will write TASK_STATUS: done at the end.", null],
    ["an unknown status", "x\nTASK_STATUS: partial", null],
    ["a list marker", "x\n- TASK_STATUS: done", { status: "done" }],
    ["a heading", "x\n## TASK_STATUS: blocked: no key", { status: "blocked", reason: "no key" }],
    [
      "blocked with a period",
      "x\nTASK_STATUS: blocked.",
      { status: "blocked", reason: "no reason given" },
    ],
    [
      "blocked and a reason without a separator",
      "x\nTASK_STATUS: blocked disk full",
      { status: "blocked", reason: "disk full" },
    ],
    [
      "a full-width colon",
      "x\nTASK_STATUS：blocked：磁盘已满",
      { status: "blocked", reason: "磁盘已满" },
    ],
    ["done with more words", "x\nTASK_STATUS: done and dusted", null],
    ["a status run into the word", "x\nTASK_STATUS: blockedness", null],
    ["a status with no colon", "x\nTASK_STATUS done", null],
    [
      "the prompt's two template lines copied back",
      "x\nTASK_STATUS: done\nTASK_STATUS: blocked: <one line: what stopped you and what a person must change>",
      null,
    ],
    [
      "a status line inside a longer fenced example",
      "Report.\n```\nexample output\nTASK_STATUS: done\n```",
      null,
    ],
    [
      "a fenced status line with text after the fence",
      "Report.\n```\nTASK_STATUS: done\n```\nMore.",
      null,
    ],
  ])("%s", (_name, text, expected) => {
    expect(workerStatus(text)).toEqual(expected);
  });

  test("a very long line is skipped quickly and is never a status line", () => {
    const long = `TASK_STATUS: done${" ".repeat(60_000)}x`;
    const started = performance.now();
    expect(workerStatus(`report\n${long}\n${" \t".repeat(30_000)}y`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("a reason over the cap is cut", () => {
    const status = workerStatus(`x\nTASK_STATUS: blocked: ${"a".repeat(900)}`);
    expect(status?.status).toBe("blocked");
    const reason = status?.status === "blocked" ? status.reason : "";
    expect(reason).toHaveLength(MAX_WORKER_BLOCKED_REASON_CHARS);
    expect(reason.endsWith("…")).toBe(true);
  });
});

describe("withoutWorkerStatus", () => {
  test("removes the status line from the report", () => {
    expect(withoutWorkerStatus("Changed a.ts.\n\nTASK_STATUS: done\n")).toBe("Changed a.ts.");
    expect(withoutWorkerStatus("Report.\nTASK_STATUS: done\nAnswer: done.")).toBe(
      "Report.\nAnswer: done.",
    );
  });

  test("removes the fences around a status line alone in them", () => {
    expect(withoutWorkerStatus("Changed a.ts.\n```\nTASK_STATUS: done\n```")).toBe("Changed a.ts.");
  });

  test("keeps a placeholder when the status line was all the worker wrote", () => {
    expect(withoutWorkerStatus("TASK_STATUS: done")).toBe("(no report)");
    expect(withoutWorkerStatus("```\nTASK_STATUS: done\n```\n")).toBe("(no report)");
  });

  test("leaves a message without a status line as it is", () => {
    expect(withoutWorkerStatus(T8_SUMMARY)).toBe(T8_SUMMARY);
  });
});

describe("blocked errors", () => {
  const error = `${WORKER_BLOCKED_PREFIX} disk full`;

  test("are recognized and need a person, but are not pending requests", () => {
    expect(isWorkerBlocked(error)).toBe(true);
    expect(isPendingRequestFailure(error)).toBe(false);
    expect(needsPerson(error)).toBe(true);
    expect(needsPerson("Agent asked a question: which?")).toBe(true);
    expect(needsPerson("boom")).toBe(false);
    expect(isWorkerBlocked(null)).toBe(false);
  });

  test("wait for a person: a blocked worker always, a pending request only under the same policy", () => {
    expect(personDecides(error, false)).toBe(true);
    expect(personDecides("Agent asked a question: which?", false)).toBe(false);
    expect(personDecides("Agent asked a question: which?", true)).toBe(true);
    expect(personDecides("boom", false)).toBe(false);
  });

  test("quote the worker's reason", () => {
    expect(workerBlockedReason(error)).toBe("disk full");
    expect(workerBlockedReason("boom")).toBeNull();
    expect(workerBlockedFailureText("t6", error)).toBe(
      'Task t6 stopped: the worker reported it was blocked: "disk full". Fix what it names and retry.',
    );
  });
});

describe("no-answer errors", () => {
  const error = `${NO_ANSWER_PREFIX} 720 minutes: Agent is waiting for permission to use Bash: git commit`;

  test("need a person whatever the policy, and are not pending requests", () => {
    expect(isNoAnswerFailure(error)).toBe(true);
    expect(isNoAnswerFailure("Turn timed out after 60 minutes")).toBe(false);
    expect(isPendingRequestFailure(error)).toBe(false);
    expect(needsPerson(error)).toBe(true);
    expect(personDecides(error, false)).toBe(true);
  });

  test("are found quoted inside another role's failure", () => {
    expect(mentionsNoAnswer(`Review failed: Reviewer did not finish (failed: ${error})`)).toBe(
      true,
    );
    expect(mentionsNoAnswer("Review failed: Reviewer did not finish (canceled)")).toBe(false);
    expect(mentionsNoAnswer(null)).toBe(false);
  });
});
