import { describe, expect, it } from "vitest";
import { CHATS_PROJECT_KEY, isChatsProject, isChatWorkspace } from "./model";

describe("chats model predicates", () => {
  it("identifies chat workspaces by workspaceKind or project key", () => {
    expect(isChatWorkspace({ workspaceKind: "chat" })).toBe(true);
    expect(isChatWorkspace({ projectViewKey: CHATS_PROJECT_KEY })).toBe(true);
    expect(isChatWorkspace({ projectKey: CHATS_PROJECT_KEY })).toBe(true);
  });

  it("does not classify regular workspaces as chats even if projectName is Chats", () => {
    expect(isChatWorkspace({ workspaceKind: "worktree", projectViewKey: "prj_custom" })).toBe(
      false,
    );
    expect(isChatWorkspace({ workspaceKind: "directory", projectViewKey: "prj_custom" })).toBe(
      false,
    );
    expect(isChatWorkspace(null)).toBe(false);
  });

  it("identifies synthetic chats project by key and ignores project display name", () => {
    expect(isChatsProject({ projectKey: CHATS_PROJECT_KEY })).toBe(true);
    expect(isChatsProject({ viewKey: CHATS_PROJECT_KEY })).toBe(true);
    expect(isChatsProject({ projectViewKey: CHATS_PROJECT_KEY })).toBe(true);

    // Normal project with display name "Chats" should NOT be identified as the synthetic project
    expect(isChatsProject({ projectKey: "repo_chats" })).toBe(false);
    expect(isChatsProject(null)).toBe(false);
  });
});
