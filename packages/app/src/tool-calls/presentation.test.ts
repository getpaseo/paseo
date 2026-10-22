import type { AgentMessage } from "@getpaseo/protocol/agent-message";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";

import { buildToolCallPresentation, type ToolCallPresentationIcon } from "./presentation";

const fakeIcons = {
  paseo: (() => null) as ToolCallPresentationIcon,
  brain: (() => null) as ToolCallPresentationIcon,
  eye: (() => null) as ToolCallPresentationIcon,
  wrench: (() => null) as ToolCallPresentationIcon,
};

function fakeResolveIcon(
  toolName: string,
  detail: ToolCallDetail | undefined,
  agentMessage: AgentMessage | undefined,
): ToolCallPresentationIcon {
  if (agentMessage) {
    return fakeIcons.paseo;
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

it.each([
  ["message", "Message received"],
  ["finished", "Agent finished"],
  ["errored", "Agent errored"],
  ["permission-required", "Agent needs permission"],
  ["closed", "Agent closed"],
] as const)(
  "presents %s with a fixed label, the sender as context, and the Paseo icon",
  (event, heading) => {
    const presentation = buildToolCallPresentation({
      toolName: "internal_name_should_not_be_visible",
      status: "completed",
      error: null,
      detail: { type: "plain_text", label: "legacy summary", text: "legacy body", icon: "bot" },
      agentMessage: {
        event,
        sender: { id: "server::sender", title: "QA messenger" },
        text: "The delivered message.",
      },
      resolveIcon: fakeResolveIcon,
    });
    expect(presentation.displayName).toBe(heading);
    expect(presentation.summary).toBe("QA messenger");
    expect(presentation.icon).toBe(fakeIcons.paseo);
    expect(presentation.detail).toEqual({
      type: "plain_text",
      text: "From agent: server::sender\n\nThe delivered message.",
    });
  },
);

it("uses an opaque sender ID when no title is available", () => {
  const presentation = buildToolCallPresentation({
    toolName: "agent_message",
    status: "completed",
    error: null,
    agentMessage: { event: "message", sender: { id: "remote::worker" }, text: "Hello" },
    resolveIcon: fakeResolveIcon,
  });
  expect(presentation.displayName).toBe("Message received");
  expect(presentation.summary).toBe("remote::worker");
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
