import { beforeEach, expect, it, vi } from "vitest";
import { useDraftStore } from "@/stores/draft-store";
import { buildNewWorkspaceDraftKey } from "@/stores/draft-keys";
import { createPluginNavigation } from "./navigation";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("expo-router", () => ({ router: navigation }));
vi.mock("@/stores/draft-keys", async (original) => ({
  ...(await original<typeof import("@/stores/draft-keys")>()),
  generateDraftId: () => "reviewed-brief",
}));

beforeEach(() => {
  navigation.push.mockReset();
  useDraftStore.setState({ drafts: {} });
});

it("prefills a native draft once without putting the brief in routes or overwriting edits", () => {
  const open = createPluginNavigation({ serverId: "host", workspaceId: null });
  open.openNewWorkspace({
    executionId: "crew:team",
    cwd: "/project",
    initialText: "Reviewed request",
  });
  const draftKey = buildNewWorkspaceDraftKey("reviewed-brief");
  expect(useDraftStore.getState().getDraftInput(draftKey)?.text).toBe("Reviewed request");
  expect(navigation.push).toHaveBeenCalledWith({
    pathname: "/new",
    params: {
      serverId: "host",
      dir: "/project",
      executionId: "crew:team",
      draftId: "reviewed-brief",
      projectId: undefined,
      presetId: undefined,
    },
  });
  expect(JSON.stringify(navigation.push.mock.calls)).not.toContain("Reviewed request");
  useDraftStore.getState().editDraftText({ draftKey, text: "User edit" });
  open.openNewWorkspace({ executionId: "crew:team", initialText: "Replacement" });
  expect(useDraftStore.getState().getDraftInput(draftKey)?.text).toBe("User edit");
});
