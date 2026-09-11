import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";

import { buildToolCallPresentation, type ToolCallPresentationIcon } from "./presentation";

const fakeIcons = {
  brain: (() => null) as ToolCallPresentationIcon,
  eye: (() => null) as ToolCallPresentationIcon,
  wrench: (() => null) as ToolCallPresentationIcon,
};

function fakeResolveIcon(
  toolName: string,
  detail: ToolCallDetail | undefined,
): ToolCallPresentationIcon {
  if (detail?.type === "plan") {
    return fakeIcons.brain;
  }
  if (detail?.type === "read") {
    return fakeIcons.eye;
  }
  if (toolName === "exec_command") {
    return fakeIcons.wrench;
  }
  return fakeIcons.wrench;
}

describe("tool-call presentation", () => {
  it("builds badge, detail, icon, and file-open policy in one model", () => {
    const presentation = buildToolCallPresentation({
      toolName: "read_file",
      status: "completed",
      error: null,
      cwd: "/tmp/repo",
      detail: {
        type: "read",
        filePath: "/tmp/repo/src/index.ts",
        content: "console.log('hi');",
      },
      resolveIcon: fakeResolveIcon,
    });

    expect(presentation).toMatchObject({
      displayName: "Read",
      summary: "src/index.ts",
      icon: fakeIcons.eye,
      isLoadingDetails: false,
      hasDetails: true,
      canOpenDetails: true,
      openFilePath: "/tmp/repo/src/index.ts",
      isPlan: false,
    });
  });

  it("marks running calls without meaningful detail as loading details", () => {
    const presentation = buildToolCallPresentation({
      toolName: "exec_command",
      status: "running",
      error: null,
      detail: {
        type: "unknown",
        input: {},
        output: null,
      },
      resolveIcon: fakeResolveIcon,
    });

    expect(presentation).toMatchObject({
      displayName: "Exec command",
      icon: fakeIcons.wrench,
      isLoadingDetails: true,
      hasDetails: false,
      canOpenDetails: true,
      openFilePath: null,
      isPlan: false,
    });
  });

  it("keeps plan calls out of the expandable badge path", () => {
    const presentation = buildToolCallPresentation({
      toolName: "ExitPlanMode",
      status: "completed",
      error: null,
      detail: {
        type: "plan",
        text: "1. Do the thing",
      },
      resolveIcon: fakeResolveIcon,
    });

    expect(presentation.isPlan).toBe(true);
    expect(presentation.icon).toBe(fakeIcons.brain);
  });
});

it("uses generated descriptions for the preview and full details without hiding failures", () => {
  const description = "Ran the app's type check. It failed because a property is missing.";
  const presentation = buildToolCallPresentation({
    toolName: "exec_command",
    status: "failed",
    error: "exit 1",
    detail: {
      type: "shell",
      command: "npm run typecheck",
      output: "Missing property",
      exitCode: 1,
    },
    metadata: { "paseo.toolCallSummary": { description } },
    resolveIcon: fakeResolveIcon,
  });
  expect(presentation).toMatchObject({
    displayName: "Shell",
    summary: description,
    description,
    errorText: "exit 1",
    canOpenDetails: true,
  });
});

it("shows a linked file read immediately and keeps input separate from the result", () => {
  const input = {
    toolName: "exec_command",
    error: null,
    detail: { type: "shell", command: "cat /Users/me/.claude/plans/keep-awake.md" } as const,
    resolveIcon: fakeResolveIcon,
  };
  expect(buildToolCallPresentation({ ...input, status: "running" })).toMatchObject({
    inputLabel: "Read keep-awake.md",
    openFilePath: "/Users/me/.claude/plans/keep-awake.md",
    description: undefined,
  });
  expect(
    buildToolCallPresentation({
      ...input,
      status: "completed",
      metadata: {
        "paseo.toolCallInputSummary": { description: "Read keep-awake.md" },
        "paseo.toolCallSummary": { description: "Plan: prevent Mac sleep during agent runs" },
      },
    }),
  ).toMatchObject({
    inputLabel: "Read keep-awake.md",
    description: "Plan: prevent Mac sleep during agent runs",
  });
});

it("opens result files relative to the command directory", () => {
  expect(
    buildToolCallPresentation({
      toolName: "exec_command",
      status: "completed",
      error: null,
      cwd: "/repo",
      detail: { type: "shell", command: "rg sleep src", cwd: "/repo/packages/app" },
      metadata: {
        "paseo.toolCallSummary": {
          description: "Found sleep.ts handler",
          filePath: "src/sleep.ts",
        },
      },
      resolveIcon: fakeResolveIcon,
    }).outputFilePath,
  ).toBe("/repo/packages/app/src/sleep.ts");
});
