/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComposerAttachment } from "@/attachments/types";
import type { MessagePayload } from "@/components/message-input";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import type { StreamItem } from "@/types/stream";
import { WorkspaceDraftAgentTab } from "./workspace-draft-agent-tab";

const {
  createAgentMock,
  latestComposerText,
  latestComposerDisabled,
  latestStreamText,
  onCreatedMock,
} = vi.hoisted(() => ({
  createAgentMock: vi.fn(),
  latestComposerText: { current: null as string | null },
  latestComposerDisabled: { current: null as boolean | null },
  latestStreamText: { current: null as string | null },
  onCreatedMock: vi.fn(),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? factory({
            colors: {
              surface0: "#000",
              surface2: "#222",
              destructive: "#f00",
            },
            spacing: { 2: 8, 3: 12, 4: 16, 6: 24 },
            borderRadius: { md: 6 },
            fontSize: { sm: 13 },
          })
        : factory,
  },
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({
    createAgent: createAgentMock,
  }),
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/stores/session-store-hooks", () => ({
  useWorkspaceExecutionAuthority: () => ({
    ok: true,
    authority: {
      workspaceId: "workspace-1",
      workspaceDirectory: "/repo/.paseo/worktrees/workspace-1",
    },
  }),
}));

vi.mock("@/hooks/use-agent-input-draft", () => ({
  useAgentInputDraft: () => {
    const [text, setText] = React.useState("please review this change");
    const [attachments, setAttachments] = React.useState<ComposerAttachment[]>([]);
    return {
      text,
      setText,
      attachments,
      setAttachments,
      cwd: "/repo/.paseo/worktrees/workspace-1",
      clear: () => {
        setText("");
        setAttachments([]);
      },
      isHydrated: true,
      composerState: {
        providerDefinitions: [{ id: "codex", label: "Codex" }],
        selectedProvider: "codex",
        selectedMode: "",
        modeOptions: [],
        selectedModel: "gpt-5.4",
        availableModels: [{ id: "gpt-5.4", label: "GPT-5.4" }],
        allProviderModels: {},
        isAllModelsLoading: false,
        isModelLoading: false,
        effectiveModelId: "gpt-5.4",
        effectiveThinkingOptionId: "",
        featureValues: undefined,
        statusControls: {
          providerDefinitions: [{ id: "codex", label: "Codex" }],
          selectedProvider: "codex",
          modeOptions: [],
          selectedMode: "",
          models: [{ id: "gpt-5.4", label: "GPT-5.4" }],
          selectedModel: "gpt-5.4",
          thinkingOptions: [],
          selectedThinkingOptionId: "",
          isModelLoading: false,
          allProviderModels: {},
          isAllModelsLoading: false,
          features: [],
        },
        commandDraftConfig: undefined,
        persistFormPreferences: vi.fn(),
      },
    };
  },
}));

vi.mock("@/utils/encode-images", () => ({
  encodeImages: vi.fn(async () => []),
}));

vi.mock("@/components/composer-attachments", () => ({
  splitComposerAttachmentsForSubmit: (attachments: ComposerAttachment[]) => ({
    images: [],
    attachments,
  }),
}));

vi.mock("@/components/composer", () => ({
  Composer: ({
    value,
    isSubmitLoading,
  }: {
    onSubmitMessage: (payload: MessagePayload) => Promise<void>;
    value: string;
    isSubmitLoading?: boolean;
  }) => {
    latestComposerText.current = value;
    latestComposerDisabled.current = isSubmitLoading ?? false;
    return (
      <textarea
        aria-label="Message agent..."
        data-testid="composer"
        disabled={isSubmitLoading}
        readOnly
        value={value}
      />
    );
  },
}));

vi.mock("@/components/agent-stream-view", () => ({
  AgentStreamView: ({ streamItems }: { streamItems: StreamItem[] }) => {
    latestStreamText.current =
      streamItems.find((item) => item.kind === "user_message")?.text ?? null;
    return <div data-testid="agent-stream-view">{latestStreamText.current}</div>;
  },
}));

vi.mock("@/components/file-drop-zone", () => ({
  FileDropZone: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

let root: Root | null = null;
let container: HTMLElement | null = null;
let queryClient: QueryClient | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  createAgentMock.mockReset();
  onCreatedMock.mockReset();
  latestComposerText.current = null;
  latestComposerDisabled.current = null;
  latestStreamText.current = null;
  useCreateFlowStore.getState().clearAll();
  useWorkspaceDraftSubmissionStore.setState({ pendingByDraftId: {} });
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  queryClient?.clear();
  root = null;
  container?.remove();
  container = null;
  queryClient = null;
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderDraftTab() {
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient!}>
        <WorkspaceDraftAgentTab
          serverId="server"
          workspaceId="workspace-1"
          tabId="draft-1"
          draftId="draft-1"
          isPaneFocused={true}
          onCreated={onCreatedMock}
          onOpenWorkspaceFile={vi.fn()}
        />
      </QueryClientProvider>,
    );
  });
}

describe("WorkspaceDraftAgentTab", () => {
  it("clears the composer while an auto-submitted new-workspace prompt is shown in the stream", async () => {
    const createAgent = createDeferredPromise<{ id: string }>();
    createAgentMock.mockImplementationOnce(async () => await createAgent.promise);
    useWorkspaceDraftSubmissionStore.getState().setPending({
      serverId: "server",
      workspaceId: "workspace-1",
      draftId: "draft-1",
      text: "please review this change",
      attachments: [],
      cwd: "/repo/.paseo/worktrees/workspace-1",
      provider: "codex",
      model: "gpt-5.4",
      allowEmptyText: true,
    });

    renderDraftTab();
    await flush();

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(latestStreamText.current).toBe("please review this change");
    expect(latestComposerDisabled.current).toBe(true);
    expect(latestComposerText.current).toBe("");
  });
});
