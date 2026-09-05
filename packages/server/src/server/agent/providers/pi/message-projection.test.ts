import { describe, expect, test } from "vitest";

import type { PiAgentMessage } from "./rpc-types.js";
import { shouldProjectPiCustomMessage } from "./message-projection.js";

function customMessage(
  content: string,
  customType?: string,
): Extract<PiAgentMessage, { role: "custom" }> {
  return {
    role: "custom",
    content,
    ...(customType ? { customType } : {}),
  };
}

const COMPLETION_STATUSES = ["completed", "failed", "paused", "stopped"];

describe("Pi custom message projection", () => {
  test.each([
    ...COMPLETION_STATUSES.flatMap((status) => [
      [`Background task ${status}`, `Background task ${status}: **worker**\n\nResult`],
      [
        `Detached foreground task ${status}`,
        `Detached foreground task ${status}: **worker** (task 1)\n\nResult`,
      ],
      [
        `Background tasks ${status}`,
        `Background tasks ${status} (2): **worker**, **reviewer**\n\nResults`,
      ],
      [
        `Detached foreground tasks ${status}`,
        `Detached foreground tasks ${status} (2): **worker**, **reviewer**\n\nResults`,
      ],
    ]),
    ["progress report", "Subagent progress update.\nRun: run-1"],
    ["attention report", "Subagent needs attention: worker\nRun: run-1"],
    ["failed control report", "Subagent failed: worker\nRun: run-1"],
    ["long-running report", "Subagent active but long-running: worker\nRun: run-1"],
    ["supervisor decision report", "Subagent needs a supervisor decision.\nRun: run-1"],
    [
      "structured supervisor interview",
      "Subagent requests a structured supervisor interview.\nRun: run-1",
    ],
  ])("suppresses a %s when Pi RPC omits customType", (_name, content) => {
    expect(shouldProjectPiCustomMessage(customMessage(content), content)).toBe(false);
  });

  test.each([
    "subagent-notify",
    "subagent_control_notice",
    "subagent_steering_notice",
    "subagent_supervisor_request",
    "subagent_watchdog_warning",
  ])("prefers the structured %s customType over message prose", (customType) => {
    const content = "Control report wording from a future pi-subagents version";
    expect(shouldProjectPiCustomMessage(customMessage(content, customType), content)).toBe(false);
  });

  test.each([
    "Extension command output",
    "Background task completed: ordinary prose without a bold agent",
    "Background task completed this is ordinary prose",
    "Background tasks completed: ordinary prose without a count",
    "Subagent progress update. This is ordinary prose on the same line",
    "Subagent needs attention from the extension user",
    "A Subagent failed: worker message that does not begin with the signature",
    "Subagent requests a structured supervisor interview from this extension.",
  ])("projects ordinary extension custom prose: %s", (content) => {
    expect(shouldProjectPiCustomMessage(customMessage(content, "extension-result"), content)).toBe(
      true,
    );
  });
});
