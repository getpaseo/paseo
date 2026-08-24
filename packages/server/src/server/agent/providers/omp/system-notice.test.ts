import { describe, expect, test } from "vitest";

import { isOmpSystemNotice, mapOmpSystemNoticeToToolCall } from "./system-notice.js";

const COMPLETED_NOTICE = [
  "<system-notice>",
  "Background job DocsSmokeTwo has completed. Resume your work using the result below.",
  '<task-result id="DocsSmokeTwo" agent="explore" status="completed" duration="21.6s">',
  '<meta lines="22" size="2.5KB" />',
  "<output>",
  '{"summary":"docs smoke check done"}',
  "</output>",
  "</task-result>",
  "</system-notice>",
  "DocsSmokeTwo is now idle — transcript at history://DocsSmokeTwo",
].join("\n");

describe("omp system notice detection", () => {
  test("detects messages that start with the system-notice tag", () => {
    expect(isOmpSystemNotice(COMPLETED_NOTICE)).toBe(true);
    expect(isOmpSystemNotice("  \n<system-notice>plain</system-notice>")).toBe(true);
  });

  test("ignores regular prompts, including ones that mention the tag mid-message", () => {
    expect(isOmpSystemNotice("please fix the bug")).toBe(false);
    expect(isOmpSystemNotice("what does <system-notice> mean in omp?")).toBe(false);
    expect(mapOmpSystemNoticeToToolCall("what does <system-notice> mean in omp?")).toBeNull();
  });
});

describe("omp system notice tool call mapping", () => {
  test("maps a completed task-result notice to a synthetic completed tool call", () => {
    expect(mapOmpSystemNoticeToToolCall(COMPLETED_NOTICE)).toEqual({
      type: "tool_call",
      callId: "omp-notice:DocsSmokeTwo",
      name: "task_notification",
      status: "completed",
      detail: {
        type: "plain_text",
        label: "Background job DocsSmokeTwo completed",
        text: COMPLETED_NOTICE,
        icon: "wrench",
      },
      metadata: {
        synthetic: true,
        source: "omp_system_notice",
        taskId: "DocsSmokeTwo",
        subagentType: "explore",
        status: "completed",
      },
      error: null,
    });
  });

  test("maps a failed task-result notice to a failed tool call", () => {
    const notice = [
      "<system-notice>",
      "Background job RepoSmokeOne has failed.",
      '<task-result id="RepoSmokeOne" agent="explore" status="failed" duration="3s">',
      "<output>boom</output>",
      "</task-result>",
      "</system-notice>",
    ].join("\n");

    const item = mapOmpSystemNoticeToToolCall(notice);
    expect(item).toMatchObject({
      callId: "omp-notice:RepoSmokeOne",
      status: "failed",
      error: "Background job RepoSmokeOne failed",
    });
  });

  test("parses task-result attributes with typographic quotes", () => {
    const notice = [
      "<system-notice>",
      "Background job DocsSmokeTwo has completed.",
      "<task-result id=“DocsSmokeTwo” agent=“explore” status=“completed” duration=“21.6s”>",
      "<output>ok</output>",
      "</task-result>",
      "</system-notice>",
    ].join("\n");

    expect(mapOmpSystemNoticeToToolCall(notice)).toMatchObject({
      callId: "omp-notice:DocsSmokeTwo",
      status: "completed",
      metadata: {
        taskId: "DocsSmokeTwo",
        subagentType: "explore",
      },
    });
  });

  test("maps a notice without a task-result using its first line and a stable hash id", () => {
    const notice = "<system-notice>\nThe daemon rotated its logs.\n</system-notice>";

    const first = mapOmpSystemNoticeToToolCall(notice);
    const second = mapOmpSystemNoticeToToolCall(notice);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "completed",
      detail: {
        type: "plain_text",
        label: "The daemon rotated its logs.",
        text: notice,
      },
    });
    expect(first?.callId).toMatch(/^omp-notice:[0-9a-f]{12}$/);
  });
});
