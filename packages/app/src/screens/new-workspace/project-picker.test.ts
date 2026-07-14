import { describe, expect, it } from "vitest";
import { CHAT_WORKSPACE_OPTION_ID, computeProjectOptionData } from "./project-picker";

describe("chat workspace picker", () => {
  it("pins the chat-workspace option only when the feature is enabled", () => {
    const project = {
      projectKey: "project-1",
      projectName: "Project",
      projectKind: "git" as const,
      iconWorkingDir: "/project",
      hosts: [],
      workspaceKeys: [],
    };

    expect(
      computeProjectOptionData({
        projects: [project],
        allowChatWorkspace: true,
        chatWorkspaceLabel: "No Workspace (chat only)",
      }).options.map((option) => option.id),
    ).toEqual([CHAT_WORKSPACE_OPTION_ID, "project:project-1"]);
    expect(
      computeProjectOptionData({
        projects: [project],
        allowChatWorkspace: false,
        chatWorkspaceLabel: "No Workspace (chat only)",
      }).options.map((option) => option.id),
    ).toEqual(["project:project-1"]);
  });
});
