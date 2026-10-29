import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createPreferredEditorPreference, resolvePreferredEditorId } from "./use-preferred-editor";

describe("resolvePreferredEditorId", () => {
  it("keeps the stored editor when it is still available", () => {
    expect(resolvePreferredEditorId(["cursor", "vscode"], "vscode")).toBe("vscode");
  });

  it("falls back to the first available editor when the stored one is missing", () => {
    expect(resolvePreferredEditorId(["zed", "finder"], "cursor")).toBe("zed");
  });

  it("falls back when a platform-specific file manager target is unavailable", () => {
    expect(resolvePreferredEditorId(["explorer", "vscode"], "finder")).toBe("explorer");
  });

  it("keeps unknown editor ids when they are still available", () => {
    expect(resolvePreferredEditorId(["unknown-editor", "cursor"], "unknown-editor")).toBe(
      "unknown-editor",
    );
  });

  it("keeps custom script target ids as plain strings", () => {
    expect(resolvePreferredEditorId(["script:open-in-nvim", "cursor"], "script:open-in-nvim")).toBe(
      "script:open-in-nvim",
    );
  });

  it("returns null when no editors are available", () => {
    expect(resolvePreferredEditorId([], "cursor")).toBeNull();
  });
});

describe("project editor preferences", () => {
  it("changing one project leaves another project's cached and persisted choice unchanged", async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem("@paseo:preferred-editor", "vscode");
    const queryClient = new QueryClient();
    const projectA = createPreferredEditorPreference({
      scope: { serverId: "host", projectId: "project-a" },
      queryClient,
      storage: AsyncStorage,
    });
    const projectB = createPreferredEditorPreference({
      scope: { serverId: "host", projectId: "project-b" },
      queryClient,
      storage: AsyncStorage,
    });
    expect(await queryClient.fetchQuery(projectA.queryOptions)).toBe("vscode");
    expect(await queryClient.fetchQuery(projectB.queryOptions)).toBe("vscode");
    await projectA.update("cursor");
    expect(await queryClient.fetchQuery(projectA.queryOptions)).toBe("cursor");
    expect(await queryClient.fetchQuery(projectB.queryOptions)).toBe("vscode");
    queryClient.clear();
    expect(await queryClient.fetchQuery(projectA.queryOptions)).toBe("cursor");
    expect(await queryClient.fetchQuery(projectB.queryOptions)).toBe("vscode");
    expect(await AsyncStorage.getItem("@paseo:preferred-editor")).toBe("vscode");
    queryClient.clear();
  });
  it("shares a choice across workspaces of the same project while isolating hosts", async () => {
    await AsyncStorage.clear();
    const queryClient = new QueryClient();
    const root = createPreferredEditorPreference({
      scope: { serverId: "host-a", projectId: "project" },
      queryClient,
      storage: AsyncStorage,
    });
    const worktree = createPreferredEditorPreference({
      scope: { serverId: "host-a", projectId: "project" },
      queryClient,
      storage: AsyncStorage,
    });
    const otherHost = createPreferredEditorPreference({
      scope: { serverId: "host-b", projectId: "project" },
      queryClient,
      storage: AsyncStorage,
    });
    await root.update("zed");
    expect(await queryClient.fetchQuery(worktree.queryOptions)).toBe("zed");
    expect(await queryClient.fetchQuery(otherHost.queryOptions)).toBeNull();
    queryClient.clear();
    expect(await queryClient.fetchQuery(worktree.queryOptions)).toBe("zed");
    expect(await queryClient.fetchQuery(otherHost.queryOptions)).toBeNull();
    queryClient.clear();
  });

  it("preserves the previous choice when saving fails", async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem("@paseo:preferred-editor", "vscode");
    const queryClient = new QueryClient();
    const preference = createPreferredEditorPreference({
      scope: { serverId: "host", projectId: "project" },
      queryClient,
      storage: {
        getItem: AsyncStorage.getItem,
        removeItem: AsyncStorage.removeItem,
        async setItem() {
          throw new Error("Storage is full");
        },
      },
    });
    expect(await queryClient.fetchQuery(preference.queryOptions)).toBe("vscode");
    await expect(preference.update("cursor")).rejects.toThrow("Storage is full");
    expect(await queryClient.fetchQuery(preference.queryOptions)).toBe("vscode");
    queryClient.clear();
  });
});
