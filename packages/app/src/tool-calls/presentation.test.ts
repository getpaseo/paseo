import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";

import { buildToolCallPresentation, type ToolCallPresentationIcon } from "./presentation";

const fakeIcons = {
  bot: (() => null) as ToolCallPresentationIcon,
  brain: (() => null) as ToolCallPresentationIcon,
  eye: (() => null) as ToolCallPresentationIcon,
  wrench: (() => null) as ToolCallPresentationIcon,
  sparkles: (() => null) as ToolCallPresentationIcon,
};

function fakeResolveIcon(
  toolName: string,
  detail: ToolCallDetail | undefined,
): ToolCallPresentationIcon {
  if (detail?.type === "plain_text" && detail.icon === "bot") {
    return fakeIcons.bot;
  }
  if (detail?.type === "plain_text" && detail.icon === "sparkles") {
    return fakeIcons.sparkles;
  }
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
  it.each([
    "The user does not want to exit plan mode. Continue planning and ask the user what they would like to do.",
    "The user wants to revise the plan. The user said:\nKeep the existing files unchanged.",
    "The user chose to abandon the plan entirely. Plan mode has been disabled.",
  ])("labels a Plan Exit result while preserving its expandable output: %s", (text) => {
    const detail: ToolCallDetail = {
      type: "plain_text",
      label: "Plan: Exit",
      text,
      icon: "wrench",
    };
    const presentation = buildToolCallPresentation({
      toolName: "other",
      status: "completed",
      error: null,
      detail,
      metadata: { kind: "other", title: "Plan: Exit" },
      resolveIcon: fakeResolveIcon,
    });
    expect(presentation).toMatchObject({
      displayName: "Plan Exit",
      summary: undefined,
      detail,
      hasDetails: true,
      canOpenDetails: true,
      isPlan: false,
    });
  });

  it.each(["running", "failed"] as const)("preserves a %s Plan Exit result", (status) => {
    const detail: ToolCallDetail = {
      type: "plain_text",
      label: "Plan: Exit",
      text: "Plan approval response",
      icon: "wrench",
    };
    const error = status === "failed" ? "Approval request failed" : null;
    const presentation = buildToolCallPresentation({
      toolName: "other",
      status,
      error,
      detail,
      metadata: { kind: "other", title: "Plan: Exit" },
      resolveIcon: fakeResolveIcon,
    });
    expect(presentation.displayName).toBe("Plan Exit");
    expect(presentation.detail).toEqual(detail);
    expect(presentation.canOpenDetails).toBe(true);
    if (error) expect(presentation.errorText).toBe(error);
  });

  it("keeps unrelated plain-text tools on the generic display path", () => {
    const detail: ToolCallDetail = {
      type: "plain_text",
      label: "Plan: Exit",
      text: "Custom output",
    };
    const presentation = buildToolCallPresentation({
      toolName: "custom_tool",
      status: "completed",
      error: null,
      detail,
      metadata: { kind: "other", title: "Plan: Exit" },
      resolveIcon: fakeResolveIcon,
    });
    expect(presentation.displayName).toBe("Custom tool");
    expect(presentation.summary).toBe("Plan: Exit");
    expect(presentation.detail).toEqual(detail);
  });

  it.each(["Plan mode entered", "Plan mode exited"])(
    "presents %s as a compact status without the path-only disclosure",
    (label) => {
      const detail: ToolCallDetail = {
        type: "plain_text",
        label,
        text: "Plan file: /tmp/session/plan.md",
        icon: "wrench",
      };
      const presentation = buildToolCallPresentation({
        toolName: "other",
        status: "completed",
        error: null,
        detail,
        metadata: { kind: "other", title: label },
        resolveIcon: fakeResolveIcon,
      });
      expect(presentation).toMatchObject({
        displayName: label,
        summary: undefined,
        detail: { type: "plain_text", label, text: undefined, icon: "sparkles" },
        icon: fakeIcons.sparkles,
        hasDetails: false,
        canOpenDetails: false,
        isLoadingDetails: false,
        openFilePath: null,
        isPlan: false,
      });
      expect(detail.text).toBe("Plan file: /tmp/session/plan.md");
    },
  );

  it.each<{
    name: string;
    patch: Partial<Parameters<typeof buildToolCallPresentation>[0]>;
  }>([
    { name: "failed status", patch: { status: "failed" } },
    { name: "running status", patch: { status: "running" } },
    { name: "error", patch: { error: "Mode switch failed" } },
    { name: "different tool", patch: { toolName: "custom_tool" } },
    { name: "missing metadata", patch: { metadata: undefined } },
    { name: "different title", patch: { metadata: { kind: "other", title: "Other event" } } },
  ])("preserves transition details for $name", ({ patch }) => {
    const detail: ToolCallDetail = {
      type: "plain_text",
      label: "Plan mode entered",
      text: "Plan file: /tmp/session/plan.md",
      icon: "wrench",
    };
    const presentation = buildToolCallPresentation({
      toolName: "other",
      status: "completed",
      error: null,
      detail,
      metadata: { kind: "other", title: detail.label },
      resolveIcon: fakeResolveIcon,
      ...patch,
    });
    expect(presentation.detail).toEqual(detail);
    expect(presentation.hasDetails).toBe(true);
    expect(presentation.canOpenDetails).toBe(true);
    expect(presentation.icon).toBe(fakeIcons.wrench);
  });

  it.each([
    "Plan file: relative/plan.md",
    "Plan file: /tmp/plan.md\nImportant warning",
    "Plan file: /tmp/plan.md\n",
    "Plan mode could not be entered",
  ])("preserves non-path-only transition output: %s", (text) => {
    const detail: ToolCallDetail = { type: "plain_text", label: "Plan mode entered", text };
    const presentation = buildToolCallPresentation({
      toolName: "other",
      status: "completed",
      error: null,
      detail,
      metadata: { kind: "other", title: detail.label },
      resolveIcon: fakeResolveIcon,
    });
    expect(presentation.detail).toEqual(detail);
    expect(presentation.canOpenDetails).toBe(true);
  });

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

  it("shows a shell call awaiting its command as Shell, loading its details", () => {
    const presentation = buildToolCallPresentation({
      toolName: "Bash",
      status: "running",
      error: null,
      detail: { type: "shell", command: "" },
      resolveIcon: fakeResolveIcon,
    });

    expect(presentation).toMatchObject({
      displayName: "Shell",
      summary: undefined,
      isLoadingDetails: true,
      hasDetails: false,
      canOpenDetails: true,
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

it.each([
  ["agent_finished", "Agent finished"],
  ["agent_errored", "Agent errored"],
  ["agent_needs_permission", "Agent needs permission"],
  ["agent_closed", "Agent closed"],
] as const)("presents the %s notification from its plain-text detail", (toolName, heading) => {
  const detail = {
    type: "plain_text" as const,
    label: "QA messenger",
    text: "The delivered notification.",
    icon: "bot" as const,
  };
  const presentation = buildToolCallPresentation({
    toolName,
    status: "completed",
    error: null,
    detail,
    resolveIcon: fakeResolveIcon,
  });
  expect(presentation.displayName).toBe(heading);
  expect(presentation.summary).toBe("QA messenger");
  expect(presentation.icon).toBe(fakeIcons.bot);
  expect(presentation.detail).toEqual(detail);
  expect(presentation.canOpenDetails).toBe(true);
});

it("shows the target agent title as context for Paseo agent tools", () => {
  const presentation = buildToolCallPresentation({
    toolName: "mcp__paseo__kill_agent",
    status: "completed",
    error: null,
    detail: { type: "unknown", input: { agentId: "agt_1" }, output: null },
    targetAgentTitle: "Reviewer",
    resolveIcon: fakeResolveIcon,
  });
  expect(presentation.displayName).toBe("Kill agent");
  expect(presentation.summary).toBe("Reviewer");
});
