import { describe, expect, it, vi } from "vitest";
import { WidgetRequestSchema } from "@getpaseo/protocol/desktop-agent-widget";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import {
  projectWidgetRequest,
  projectWidgetIdentity,
  buildWidgetPermissionResponse,
  respondToWidgetRequest,
} from "./model";

const plan: AgentPermissionRequest = {
  id: "p1",
  provider: "codex",
  name: "Plan",
  kind: "plan",
  metadata: { planText: "# Safe plan\n<script>alert(1)</script>" },
  actions: [{ id: "implement", label: "Implement", behavior: "allow", variant: "primary" }],
};
describe("desktop agent widget", () => {
  it("preserves project identity across the widget IPC boundary and rejects remote logos", () => {
    const project = projectWidgetIdentity(
      { projectName: "Atlas", viewKey: "atlas" },
      { gitRuntime: { currentBranch: "feat/widget-header" } },
      new Map([["atlas", { dataUri: "data:image/png;base64,aWNvbg==", emoji: null }]]),
    );
    expect(project).toMatchObject({
      name: "Atlas",
      branchName: "feat/widget-header",
      iconDataUri: "data:image/png;base64,aWNvbg==",
    });
    expect(
      projectWidgetIdentity(
        { projectName: "Atlas", viewKey: "atlas" },
        undefined,
        new Map([["atlas", { dataUri: null, emoji: "🚀" }]]),
      ),
    ).toMatchObject({ name: "Atlas", branchName: "", emoji: "🚀", iconDataUri: null });
    const item = projectWidgetRequest({
      serverId: "host",
      agentId: "agent",
      request: plan,
      agentTitle: "Agent name",
      workspace: "Different workspace title",
      project,
    });
    expect(WidgetRequestSchema.parse(item).project).toEqual(project);
    expect(
      WidgetRequestSchema.safeParse({
        ...item,
        project: {
          ...project,
          iconDataUri: "https://example.com/tracking.png",
        },
      }).success,
    ).toBe(false);
  });

  it("projects pending plans safely and approves the provider's primary action", () => {
    const item = projectWidgetRequest({
      serverId: "host",
      agentId: "agent",
      request: plan,
      agentTitle: "My agent",
      workspace: "Paseo / accra",
    });
    expect(item?.kind).toBe("plan");
    expect(item?.planHtml).toContain("&lt;script&gt;");
    expect(item?.planHtml).not.toContain("<script>");
    expect(buildWidgetPermissionResponse(plan, { type: "approve", key: item!.key })).toEqual({
      behavior: "allow",
      selectedActionId: "implement",
    });
  });
});

it("validates question choices and keeps optional empty answers", () => {
  const request: AgentPermissionRequest = {
    id: "q1",
    provider: "codex",
    name: "Questions",
    kind: "question",
    input: {
      questions: [
        {
          header: "Choice",
          question: "Which?",
          options: [{ label: "One" }, { label: "Two" }],
          multiSelect: false,
        },
        { header: "Note", question: "Details?", options: [], allowEmpty: true },
      ],
    },
  };
  expect(() =>
    buildWidgetPermissionResponse(request, {
      type: "answer",
      key: "q",
      selections: [[2], []],
      texts: ["", ""],
    }),
  ).toThrow("Invalid question option");
  expect(() =>
    buildWidgetPermissionResponse(request, {
      type: "answer",
      key: "q",
      selections: [[0, 1], []],
      texts: ["", ""],
    }),
  ).toThrow("Select one option");
  expect(() =>
    buildWidgetPermissionResponse(request, {
      type: "answer",
      key: "q",
      selections: [[], []],
      texts: ["", ""],
    }),
  ).toThrow("Answer all required questions");
  expect(
    buildWidgetPermissionResponse(request, {
      type: "answer",
      key: "q",
      selections: [[1], []],
      texts: ["", ""],
    }),
  ).toEqual({
    behavior: "allow",
    updatedInput: { ...request.input, answers: { Choice: "Two", Note: "" } },
  });
  expect(() => buildWidgetPermissionResponse(request, { type: "approve", key: "q" })).toThrow(
    "This request has changed",
  );
});

it("sends comments to the current agent through the acknowledged message path", async () => {
  const sendAgentMessage = vi.fn().mockResolvedValue(undefined);
  const respondToPermissionAndWait = vi.fn().mockResolvedValue(undefined);
  await respondToWidgetRequest({
    client: { sendAgentMessage, respondToPermissionAndWait },
    agentId: "agent",
    request: plan,
    operationId: "delivery",
    action: { type: "comment", key: "key", message: "Please revise the tests." },
  });
  expect(sendAgentMessage).toHaveBeenCalledWith("agent", "Please revise the tests.", {
    messageId: "delivery",
    activeTurnBehavior: "interrupt",
  });
  expect(respondToPermissionAndWait).not.toHaveBeenCalled();
  sendAgentMessage.mockRejectedValueOnce(new Error("Disconnected"));
  await expect(
    respondToWidgetRequest({
      client: { sendAgentMessage, respondToPermissionAndWait },
      agentId: "agent",
      request: plan,
      operationId: "delivery-2",
      action: { type: "comment", key: "key", message: "Keep this draft." },
    }),
  ).rejects.toThrow("Disconnected");
});
