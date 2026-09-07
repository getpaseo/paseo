import { describe, expect, test } from "vitest";

import { isOmpSystemNotice, mapOmpSystemNoticeToNotification } from "./system-notice.js";

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
    expect(mapOmpSystemNoticeToNotification("what does <system-notice> mean in omp?")).toBeNull();
  });
});

describe("omp system notice notification mapping", () => {
  test("maps a completed task-result notice to an info notification", () => {
    expect(mapOmpSystemNoticeToNotification(COMPLETED_NOTICE)).toEqual({
      type: "notification",
      level: "info",
      message: "Background job DocsSmokeTwo completed",
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

    const item = mapOmpSystemNoticeToNotification(notice);
    expect(item).toEqual({
      type: "notification",
      level: "error",
      message: "Background job RepoSmokeOne failed",
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

    expect(mapOmpSystemNoticeToNotification(notice)).toEqual({
      type: "notification",
      level: "info",
      message: "Background job DocsSmokeTwo completed",
    });
  });

  test("maps a notice without a task-result using its first line", () => {
    const notice = "<system-notice>\nThe daemon rotated its logs.\n</system-notice>";

    const first = mapOmpSystemNoticeToNotification(notice);
    const second = mapOmpSystemNoticeToNotification(notice);
    expect(first).toEqual(second);
    expect(first).toEqual({
      type: "notification",
      level: "info",
      message: "The daemon rotated its logs.",
    });
  });
});
