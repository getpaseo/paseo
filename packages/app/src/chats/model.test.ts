import { describe, expect, it } from "vitest";
import { CHATS_PROJECT_KEY, isChatsProject, isChatWorkspace } from "./model";

describe("chats model predicates", () => {
  it("identifies chat workspaces by workspaceKind or project key or name or path", () => {
    expect(isChatWorkspace({ workspaceKind: "chat" })).toBe(true);
    expect(isChatWorkspace({ projectViewKey: CHATS_PROJECT_KEY })).toBe(true);
    expect(isChatWorkspace({ projectKey: CHATS_PROJECT_KEY })).toBe(true);
    expect(isChatWorkspace({ projectName: "Chats" })).toBe(true);
    expect(isChatWorkspace({ projectName: "Chat" })).toBe(true);
    expect(
      isChatWorkspace({ workspaceDirectory: "/Users/sanyi/paseo-chat-sessions/session-1" }),
    ).toBe(true);
  });

  it("identifies synthetic chats project by key, name, or path", () => {
    expect(isChatsProject({ projectKey: CHATS_PROJECT_KEY })).toBe(true);
    expect(isChatsProject({ viewKey: CHATS_PROJECT_KEY })).toBe(true);
    expect(isChatsProject({ projectViewKey: CHATS_PROJECT_KEY })).toBe(true);
    expect(isChatsProject({ projectName: "Chats" })).toBe(true);
    expect(isChatsProject({ projectName: "Chat" })).toBe(true);
    expect(isChatsProject({ displayName: "Chats" })).toBe(true);
    expect(isChatsProject({ iconWorkingDir: "/Users/sanyi/paseo-chat-sessions" })).toBe(true);
    expect(isChatsProject({ projectRootPath: "/Users/sanyi/.paseo/chats" })).toBe(true);

    expect(isChatsProject({ projectKey: "repo_custom", projectName: "FrontendApp" })).toBe(false);
    expect(isChatsProject(null)).toBe(false);
  });
});
