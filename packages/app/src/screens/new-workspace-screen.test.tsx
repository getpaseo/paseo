import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerAttachment } from "@/attachments/types";
import type { CreatePaseoWorktreeInput } from "@server/client/daemon-client";
import type { GitHubSearchItem } from "@server/shared/messages";
import { NewWorkspaceScreen } from "./new-workspace-screen";

const {
  theme,
  mockClient,
  mergeWorkspacesMock,
  setAgentsMock,
  navigateMock,
  createdAgent,
  createdWorkspace,
  prItem,
  prItemB,
  issueItem,
  initialAttachments,
  initialDraftState,
} = vi.hoisted(() => {
  const theme = {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
    iconSize: { sm: 14, md: 18, lg: 22 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6, lg: 8, "2xl": 16 },
    fontSize: { xs: 11, sm: 13, base: 15, lg: 18 },
    fontWeight: { medium: "500" },
    shadow: { md: {} },
    colors: {
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      popoverForeground: "#fff",
      border: "#555",
      destructive: "#ff453a",
      palette: {
        zinc: { 600: "#52525b" },
      },
    },
  };

  const prItem: GitHubSearchItem = {
    kind: "pr",
    number: 202,
    title: "Refactor picker",
    url: "https://example.com/pull/202",
    state: "open",
    body: null,
    labels: [],
    baseRefName: "main",
    headRefName: "feature/picker",
  };

  const prItemB: GitHubSearchItem = {
    kind: "pr",
    number: 303,
    title: "Polish composer chip",
    url: "https://example.com/pull/303",
    state: "open",
    body: null,
    labels: [],
    baseRefName: "main",
    headRefName: "feature/composer-chip",
  };

  const issueItem: GitHubSearchItem = {
    kind: "issue",
    number: 44,
    title: "Keep manual attachment",
    url: "https://example.com/issues/44",
    state: "open",
    body: null,
    labels: [],
  };

  const initialAttachments: ComposerAttachment[] = [];
  const initialDraftState = { text: "" };

  const createdWorkspace = {
    id: "workspace-1",
    workspaceDirectory: "/repo/.paseo/worktrees/workspace-1",
  };

  const createdAgent = {
    id: "agent-1",
    cwd: createdWorkspace.workspaceDirectory,
  };

  const mockClient = {
    isConnected: true,
    getCheckoutStatus: vi.fn(async () => ({ currentBranch: "main" })),
    getBranchSuggestions: vi.fn(async () => ({ branches: ["main", "dev", "feat/x"] })),
    searchGitHub: vi.fn(async () => ({
      items: [prItem, prItemB],
      githubFeaturesEnabled: true,
      error: null,
    })),
    createPaseoWorktree: vi.fn(async (_input: CreatePaseoWorktreeInput) => ({
      workspace: createdWorkspace,
      error: null,
    })),
    createAgent: vi.fn(async () => createdAgent),
  };

  return {
    theme,
    mockClient,
    mergeWorkspacesMock: vi.fn(),
    setAgentsMock: vi.fn(),
    navigateMock: vi.fn(),
    createdAgent,
    createdWorkspace,
    prItem,
    prItemB,
    issueItem,
    initialAttachments,
    initialDraftState,
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("@/constants/layout", () => ({
  HEADER_INNER_HEIGHT: 48,
  HEADER_INNER_HEIGHT_MOBILE: 56,
  HEADER_TOP_PADDING_MOBILE: 8,
  MAX_CONTENT_WIDTH: 900,
  useIsCompactFormFactor: () => false,
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    ChevronDown: createIcon("ChevronDown"),
    GitBranch: createIcon("GitBranch"),
    GitPullRequest: createIcon("GitPullRequest"),
  };
});

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => mockClient,
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      mergeWorkspaces: mergeWorkspacesMock,
      setAgents: setAgentsMock,
    }),
  normalizeWorkspaceDescriptor: (workspace: unknown) => workspace,
}));

vi.mock("@/utils/agent-snapshots", () => ({
  normalizeAgentSnapshot: (agent: unknown) => agent,
}));

vi.mock("@/utils/encode-images", () => ({
  encodeImages: vi.fn(async () => []),
}));

vi.mock("@/utils/error-messages", () => ({
  toErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("@/utils/workspace-execution", () => ({
  requireWorkspaceExecutionAuthority: (input: { workspace: { workspaceDirectory: string } }) => ({
    workspaceDirectory: input.workspace.workspaceDirectory,
  }),
}));

vi.mock("@/utils/workspace-navigation", () => ({
  navigateToPreparedWorkspaceTab: navigateMock,
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn() }),
}));

vi.mock("@/hooks/use-agent-input-draft", () => ({
  useAgentInputDraft: () => {
    const [attachments, setAttachments] = React.useState<ComposerAttachment[]>(initialAttachments);
    const [text, setText] = React.useState(initialDraftState.text);
    return {
      text,
      setText,
      attachments,
      setAttachments,
      cwd: "/repo",
      composerState: {
        selectedProvider: "claude-code",
        selectedMode: "",
        modeOptions: [],
        effectiveModelId: null,
        effectiveThinkingOptionId: null,
        commandDraftConfig: undefined,
        statusControls: {},
      },
    };
  },
}));

vi.mock("@/components/composer", () => ({
  Composer: ({
    onSubmitMessage,
    submitBehavior,
    submitIcon,
    isSubmitLoading,
    value,
    onChangeText,
    attachments,
    onChangeAttachments,
  }: {
    onSubmitMessage: (payload: {
      text: string;
      attachments: ComposerAttachment[];
      cwd: string;
    }) => void;
    submitBehavior?: "clear" | "preserve-and-lock";
    submitIcon?: "arrow" | "return";
    isSubmitLoading?: boolean;
    value: string;
    onChangeText: (text: string) => void;
    attachments: ComposerAttachment[];
    onChangeAttachments: (attachments: ComposerAttachment[]) => void;
  }) => (
    <div
      data-testid="test-composer"
      data-submit-behavior={submitBehavior}
      data-submit-icon={submitIcon}
    >
      <textarea
        aria-label="Message agent..."
        disabled={submitBehavior === "preserve-and-lock" && isSubmitLoading}
        value={value}
        onChange={(event) => onChangeText(event.currentTarget.value)}
      />
      <button
        type="button"
        data-testid="message-input-attach-button"
        disabled={submitBehavior === "preserve-and-lock" && isSubmitLoading}
      >
        Attach
      </button>
      {attachments.map((attachment) =>
        attachment.kind === "github_pr" || attachment.kind === "github_issue" ? (
          <div
            data-testid="composer-github-attachment-pill"
            key={`${attachment.kind}-${attachment.item.number}`}
          >
            #{attachment.item.number} {attachment.item.title}
            <button
              type="button"
              aria-label={`Remove ${attachment.kind === "github_pr" ? "PR" : "issue"} #${
                attachment.item.number
              }`}
              disabled={submitBehavior === "preserve-and-lock" && isSubmitLoading}
              onClick={() =>
                onChangeAttachments(
                  attachments.filter(
                    (candidate) =>
                      candidate.kind !== attachment.kind ||
                      candidate.item.number !== attachment.item.number,
                  ),
                )
              }
            >
              Remove
            </button>
          </div>
        ) : null,
      )}
      <button
        type="button"
        data-testid="test-composer-submit"
        onClick={() => onSubmitMessage({ text: value, attachments, cwd: "/repo" })}
      >
        Submit
      </button>
    </div>
  ),
}));

vi.mock("@/components/composer-attachments", () => ({
  splitComposerAttachmentsForSubmit: (attachments: ComposerAttachment[]) => ({
    images: [],
    attachments: attachments.flatMap((attachment) => {
      if (attachment.kind === "github_pr") {
        return [
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: attachment.item.number,
            title: attachment.item.title,
            url: attachment.item.url,
          },
        ];
      }
      if (attachment.kind === "github_issue") {
        return [
          {
            type: "github_issue",
            mimeType: "application/github-issue",
            number: attachment.item.number,
            title: attachment.item.title,
            url: attachment.item.url,
          },
        ];
      }
      return [];
    }),
  }),
}));

vi.mock("@/components/desktop/titlebar-drag-region", () => ({
  TitlebarDragRegion: () => null,
}));

vi.mock("@/components/headers/menu-header", () => ({
  SidebarMenuToggle: () => null,
}));

vi.mock("@/components/headers/screen-header", () => ({
  ScreenHeader: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({
    open,
    options,
    renderOption,
    onSelect,
  }: {
    open?: boolean;
    options: Array<{ id: string; label: string }>;
    renderOption?: (input: {
      option: { id: string; label: string };
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => React.ReactElement;
    onSelect: (id: string) => void;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="ref-picker-combobox">
        {options.map((option) =>
          renderOption ? (
            <React.Fragment key={option.id}>
              {renderOption({
                option,
                selected: false,
                active: false,
                onPress: () => onSelect(option.id),
              })}
            </React.Fragment>
          ) : (
            <button type="button" key={option.id} onClick={() => onSelect(option.id)}>
              {option.label}
            </button>
          ),
        )}
      </div>
    );
  },
  ComboboxItem: ({
    label,
    onPress,
    testID,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    testID?: string;
    disabled?: boolean;
  }) => (
    <button type="button" data-testid={testID} disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));

vi.mock("mnemonic-id", () => ({
  createNameId: () => "gentle-slug",
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  return actual;
});

let root: Root | null = null;
let container: HTMLElement | null = null;
let queryClient: QueryClient | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockClient.getBranchSuggestions.mockClear();
  mockClient.searchGitHub.mockClear();
  mockClient.searchGitHub.mockResolvedValue({
    items: [prItem, prItemB],
    githubFeaturesEnabled: true,
    error: null,
  });
  mockClient.createPaseoWorktree.mockClear();
  mockClient.createAgent.mockClear();
  initialAttachments.length = 0;
  initialDraftState.text = "";
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  queryClient?.clear();
  root = null;
  container = null;
  queryClient = null;
  vi.unstubAllGlobals();
});

function renderScreen() {
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient!}>
        <NewWorkspaceScreen serverId="server" sourceDirectory="/repo" />
      </QueryClientProvider>,
    );
  });
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function findByTestId(testID: string): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await flush();
    const element = document.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;
    if (element) return element;
  }
  throw new Error(`Missing element with testID ${testID}`);
}

function queryByTestId(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function queryAllByTestId(testID: string): HTMLElement[] {
  return Array.from(document.querySelectorAll(`[data-testid="${testID}"]`)) as HTMLElement[];
}

type CreatePaseoWorktreeArg = Parameters<typeof mockClient.createPaseoWorktree>[0];

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function firstCreateWorktreeCall(): CreatePaseoWorktreeArg {
  const calls = mockClient.createPaseoWorktree.mock.calls;
  const firstCall = calls[0];
  if (!firstCall) throw new Error("createPaseoWorktree not called");
  return firstCall[0];
}

describe("NewWorkspaceScreen picker payload", () => {
  it("searches only GitHub PRs for the picker", async () => {
    renderScreen();
    await flush();

    expect(mockClient.searchGitHub).toHaveBeenCalledWith({
      cwd: "/repo",
      query: "",
      limit: 20,
      kinds: ["github-pr"],
    });
  });

  it("sends no new fields when nothing is selected (default)", async () => {
    renderScreen();
    await flush();

    click(await findByTestId("test-composer-submit"));
    await flush();

    expect(mockClient.createPaseoWorktree).toHaveBeenCalledTimes(1);
    const call = firstCreateWorktreeCall();
    expect(call).toMatchObject({
      cwd: "/repo",
      worktreeSlug: "gentle-slug",
    });
    expect(call).not.toHaveProperty("refName");
    expect(call).not.toHaveProperty("action");
    expect(call).not.toHaveProperty("githubPrNumber");
  });

  it("shows the selected PR number, title, and PR icon in the picker trigger", async () => {
    renderScreen();
    await flush();

    click(await findByTestId("new-workspace-ref-picker-trigger"));
    await flush();

    click(await findByTestId(`new-workspace-ref-picker-pr-${prItem.number}`));
    await flush();

    const trigger = await findByTestId("new-workspace-ref-picker-trigger");
    expect(trigger.textContent).toContain(`#${prItem.number}`);
    expect(trigger.textContent).toContain(prItem.title);
    expect(trigger.textContent).not.toContain("feature/picker");
    expect(trigger.querySelectorAll('[data-icon="GitPullRequest"]')).toHaveLength(1);
  });

  it("adds the selected picker PR as a composer attachment pill", async () => {
    renderScreen();
    await flush();

    click(await findByTestId("new-workspace-ref-picker-trigger"));
    await flush();

    click(await findByTestId(`new-workspace-ref-picker-pr-${prItem.number}`));
    await flush();

    const pills = queryAllByTestId("composer-github-attachment-pill");
    expect(pills).toHaveLength(1);
    expect(pills[0]?.textContent).toContain(`#${prItem.number}`);
    expect(pills[0]?.textContent).toContain("Refactor picker");
  });

  it("replaces the picker-owned composer PR pill when another PR is selected", async () => {
    renderScreen();
    await flush();

    click(await findByTestId("new-workspace-ref-picker-trigger"));
    await flush();

    click(await findByTestId(`new-workspace-ref-picker-pr-${prItem.number}`));
    await flush();

    click(await findByTestId("new-workspace-ref-picker-trigger"));
    await flush();

    click(await findByTestId(`new-workspace-ref-picker-pr-${prItemB.number}`));
    await flush();

    const pills = queryAllByTestId("composer-github-attachment-pill");
    expect(pills).toHaveLength(1);
    expect(pills[0]?.textContent).toContain(`#${prItemB.number}`);
    expect(pills[0]?.textContent).toContain("Polish composer chip");
    expect(pills[0]?.textContent).not.toContain(`#${prItem.number}`);
  });

  it("removes the picker-owned PR pill when switching to a branch and preserves user-added chips", async () => {
    initialAttachments.push({ kind: "github_issue", item: issueItem });
    renderScreen();
    await flush();

    click(await findByTestId("new-workspace-ref-picker-trigger"));
    await flush();

    click(await findByTestId(`new-workspace-ref-picker-pr-${prItem.number}`));
    await flush();

    click(await findByTestId("new-workspace-ref-picker-trigger"));
    await flush();

    click(await findByTestId("new-workspace-ref-picker-branch-dev"));
    await flush();

    const pills = queryAllByTestId("composer-github-attachment-pill");
    expect(pills).toHaveLength(1);
    expect(pills[0]?.textContent).toContain(`#${issueItem.number}`);
    expect(pills[0]?.textContent).toContain(issueItem.title);
    expect(pills[0]?.textContent).not.toContain(`#${prItem.number}`);
  });

  it("sends action=branch-off with the branch name when a branch row is selected", async () => {
    renderScreen();
    await flush();

    click(await findByTestId("new-workspace-ref-picker-trigger"));
    await flush();

    click(await findByTestId("new-workspace-ref-picker-branch-dev"));
    await flush();

    click(await findByTestId("test-composer-submit"));
    await flush();

    expect(mockClient.createPaseoWorktree).toHaveBeenCalledTimes(1);
    const call = firstCreateWorktreeCall();
    expect(call).toMatchObject({
      cwd: "/repo",
      worktreeSlug: "gentle-slug",
      action: "branch-off",
      refName: "dev",
    });
    expect(call).not.toHaveProperty("githubPrNumber");
  });

  it("sends action=checkout with pr number + head ref when a github PR row is selected", async () => {
    renderScreen();
    await flush();

    click(await findByTestId("new-workspace-ref-picker-trigger"));
    await flush();

    click(await findByTestId(`new-workspace-ref-picker-pr-${prItem.number}`));
    await flush();

    click(await findByTestId("test-composer-submit"));
    await flush();

    expect(mockClient.createPaseoWorktree).toHaveBeenCalledTimes(1);
    const call = firstCreateWorktreeCall();
    expect(call).toMatchObject({
      cwd: "/repo",
      worktreeSlug: "gentle-slug",
      action: "checkout",
      refName: "feature/picker",
      githubPrNumber: 202,
    });
  });

  it("sends the selected PR attachment when creating the worktree", async () => {
    renderScreen();
    await flush();

    click(await findByTestId("new-workspace-ref-picker-trigger"));
    await flush();

    click(await findByTestId(`new-workspace-ref-picker-pr-${prItem.number}`));
    await flush();

    click(await findByTestId("test-composer-submit"));
    await flush();

    const call = firstCreateWorktreeCall();
    const attachments = call.attachments ?? [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ type: "github_pr", number: 202 });
  });

  it("keeps the selected PR attachment when the PR query refreshes after selection", async () => {
    renderScreen();
    await flush();

    click(await findByTestId("new-workspace-ref-picker-trigger"));
    await flush();

    click(await findByTestId(`new-workspace-ref-picker-pr-${prItem.number}`));
    await flush();

    mockClient.searchGitHub.mockResolvedValue({
      items: [],
      githubFeaturesEnabled: true,
      error: null,
    });
    await act(async () => {
      await queryClient?.invalidateQueries({
        queryKey: ["new-workspace-github-prs", "server", "/repo"],
      });
    });
    await flush();

    click(await findByTestId("test-composer-submit"));
    await flush();

    const call = firstCreateWorktreeCall();
    expect(call.attachments).toHaveLength(1);
    expect(call.attachments?.[0]).toMatchObject({ type: "github_pr", number: 202 });
  });

  it("omits PR rows from the picker when GitHub features are disabled", async () => {
    mockClient.searchGitHub.mockResolvedValueOnce({
      items: [],
      githubFeaturesEnabled: false,
      error: null,
    });
    renderScreen();
    await flush();

    click(await findByTestId("new-workspace-ref-picker-trigger"));
    await flush();

    expect(queryByTestId(`new-workspace-ref-picker-pr-${prItem.number}`)).toBeNull();
    expect((await findByTestId("new-workspace-ref-picker-branch-dev")).textContent).toContain(
      "dev",
    );
  });

  it("preserves and locks the composer and picker while chat creation is pending, then unlocks on error", async () => {
    initialDraftState.text = "please review this change";
    const createAgent = createDeferredPromise<typeof createdAgent>();
    mockClient.createAgent.mockImplementationOnce(async () => await createAgent.promise);
    renderScreen();
    await flush();

    click(await findByTestId("new-workspace-ref-picker-trigger"));
    await flush();

    click(await findByTestId(`new-workspace-ref-picker-pr-${prItem.number}`));
    await flush();

    click(await findByTestId("new-workspace-ref-picker-trigger"));
    await flush();

    click(await findByTestId("test-composer-submit"));
    await flush();

    const textInput = document.querySelector('[aria-label="Message agent..."]');
    const removeButton = document.querySelector(`[aria-label="Remove PR #${prItem.number}"]`);
    expect(queryByTestId("test-composer")?.dataset.submitBehavior).toBe("preserve-and-lock");
    expect(queryByTestId("test-composer")?.dataset.submitIcon).toBe("return");
    expect(textInput).toHaveProperty("value", "please review this change");
    expect(textInput).toHaveProperty("disabled", true);
    expect(queryByTestId("composer-github-attachment-pill")).not.toBeNull();
    expect(removeButton).toHaveProperty("disabled", true);
    expect(queryByTestId("message-input-attach-button")).toHaveProperty("disabled", true);
    expect(queryByTestId("new-workspace-ref-picker-trigger")).toHaveProperty("disabled", true);
    expect(queryByTestId("new-workspace-ref-picker-branch-dev")).toHaveProperty("disabled", true);

    createAgent.reject(new Error("Create agent failed"));
    await flush();

    expect(textInput).toHaveProperty("value", "please review this change");
    expect(textInput).toHaveProperty("disabled", false);
    expect(queryByTestId("composer-github-attachment-pill")).not.toBeNull();
    expect(removeButton).toHaveProperty("disabled", false);
    expect(queryByTestId("message-input-attach-button")).toHaveProperty("disabled", false);
    expect(queryByTestId("new-workspace-ref-picker-trigger")).toHaveProperty("disabled", false);
    expect(queryByTestId("new-workspace-ref-picker-branch-dev")).toHaveProperty("disabled", false);
  });
});
