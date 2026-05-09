import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ComposerAttachment } from "@/attachments/types";
import type { MessagePayload } from "@/components/message-input";

const navigateToWorkspace = vi.hoisted(() => vi.fn());
const component = () => null;

vi.doMock("react-native", () => ({
  Platform: { OS: "web" },
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
}));
vi.doMock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  useUnistyles: () => ({ theme: {} }),
}));
vi.doMock("lucide-react-native", () => ({
  ChevronDown: component,
  GitBranch: component,
  GitPullRequest: component,
}));
vi.doMock("@/hooks/use-workspace-navigation", () => ({ navigateToWorkspace }));

const importMocks: Record<string, Record<string, unknown>> = {
  "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 0 }) },
  "react-native-reanimated": { default: { View: "AnimatedView" } },
  "mnemonic-id": { createNameId: () => "test-workspace" },
  "@tanstack/react-query": { useQuery: () => ({}) },
  "@/components/composer": { Composer: component },
  "@/components/composer-attachments": {
    splitComposerAttachmentsForSubmit: () => ({ attachments: [] }),
  },
  "@/components/ui/combobox": { Combobox: component, ComboboxItem: component },
  "@/components/ui/tooltip": {
    Tooltip: passThrough,
    TooltipContent: passThrough,
    TooltipTrigger: passThrough,
  },
  "@/components/desktop/titlebar-drag-region": { TitlebarDragRegion: component },
  "@/components/headers/menu-header": { SidebarMenuToggle: component },
  "@/components/headers/screen-header": { ScreenHeader: component },
  "@/constants/layout": {
    HEADER_INNER_HEIGHT: 48,
    MAX_CONTENT_WIDTH: 720,
    useIsCompactFormFactor: () => false,
  },
  "@/contexts/toast-context": { useToast: () => ({ error: vi.fn() }) },
  "@/hooks/use-agent-input-draft": { useAgentInputDraft: () => ({}) },
  "@/hooks/use-keyboard-shift-style": { useKeyboardShiftStyle: () => ({ style: {} }) },
  "@/runtime/host-runtime": {
    useHostRuntimeClient: () => null,
    useHostRuntimeIsConnected: () => false,
  },
  "@/stores/session-store": {
    normalizeWorkspaceDescriptor: (workspace: unknown) => workspace,
    useSessionStore: () => vi.fn(),
  },
  "@/stores/draft-keys": {
    buildDraftStoreKey: () => "draft-key",
    generateDraftId: () => "draft-id",
  },
  "@/stores/draft-store": {
    useDraftStore: { getState: () => ({ saveDraftInput: vi.fn(), clearDraftInput: vi.fn() }) },
  },
  "@/stores/workspace-draft-submission-store": {
    useWorkspaceDraftSubmissionStore: { getState: () => ({ setPending: vi.fn() }) },
  },
  "@/utils/error-messages": { toErrorMessage: (error: unknown) => String(error) },
  "@/utils/workspace-navigation": { navigateToPreparedWorkspaceTab: vi.fn() },
};

for (const [id, exports] of Object.entries(importMocks)) vi.doMock(id, () => exports);

function passThrough({ children }: { children: unknown }) {
  return children;
}

let isEmptyWorkspaceSubmission: (payload: MessagePayload) => boolean;
let runCreateEmptyWorkspace: typeof import("./new-workspace-screen").runCreateEmptyWorkspace;

beforeAll(async () => {
  ({ isEmptyWorkspaceSubmission, runCreateEmptyWorkspace } =
    await import("./new-workspace-screen"));
});

function payload(
  input: { text?: string; attachments?: ComposerAttachment[] } = {},
): MessagePayload {
  return { text: input.text ?? "", attachments: input.attachments ?? [], cwd: "/sample/repo" };
}

describe("runCreateEmptyWorkspace", () => {
  it("creates a workspace without prompt or attachments and navigates to it", async () => {
    const workspace = { id: "workspace-123" };
    const ensureWorkspace = vi.fn().mockResolvedValue(workspace);

    await runCreateEmptyWorkspace({ payload: payload(), ensureWorkspace, serverId: "server-abc" });

    expect(ensureWorkspace).toHaveBeenCalledOnce();
    expect(ensureWorkspace).toHaveBeenCalledWith({
      cwd: "/sample/repo",
      prompt: "",
      attachments: [],
    });
    expect(navigateToWorkspace).toHaveBeenCalledOnce();
    expect(navigateToWorkspace).toHaveBeenCalledWith("server-abc", workspace.id);
  });
});

describe("isEmptyWorkspaceSubmission", () => {
  it("treats whitespace-only text with no attachments as empty, but any attachment as non-empty", () => {
    const attachment: ComposerAttachment = {
      kind: "image",
      metadata: {
        id: "image-1",
        mimeType: "image/png",
        storageType: "web-indexeddb",
        storageKey: "image-1",
        createdAt: 0,
      },
    };

    expect(isEmptyWorkspaceSubmission(payload({ text: " \n\t " }))).toBe(true);
    expect(isEmptyWorkspaceSubmission(payload({ attachments: [attachment] }))).toBe(false);
  });
});
