import React, { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import type { GitHubSearchItem } from "@server/shared/messages";
import { Composer } from "./composer";
import { splitComposerAttachmentsForSubmit } from "./composer-attachments";

const {
  theme,
  imageMetadata,
  issueItem,
  prItem,
  mockClient,
  pickImagesMock,
  persistAttachmentFromBlobMock,
  deleteAttachmentsMock,
  encodeImagesMock,
  openExternalUrlMock,
  mockSessionState,
  setAgentStreamTailMock,
  setAgentStreamHeadMock,
  setQueuedMessagesMock,
} = vi.hoisted(() => {
  const theme = {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
    iconSize: { sm: 14, md: 18, lg: 22 },
    borderWidth: { 1: 1 },
    borderRadius: { full: 999, md: 6, lg: 8, "2xl": 16 },
    fontSize: { xs: 11, sm: 13, base: 15, lg: 18 },
    fontWeight: { normal: "400", medium: "500" },
    shadow: { md: {} },
    colors: {
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      surface4: "#888",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      popoverForeground: "#fff",
      border: "#555",
      borderAccent: "#444",
      accent: "#0a84ff",
      accentForeground: "#fff",
      destructive: "#ff453a",
      palette: {
        green: { 500: "#30d158", 600: "#24b14c", 800: "#126024" },
        red: { 500: "#ff453a", 600: "#d92d20" },
        zinc: { 600: "#52525b" },
      },
    },
  };

  const imageMetadata: AttachmentMetadata = {
    id: "img-1",
    mimeType: "image/png",
    storageType: "web-indexeddb",
    storageKey: "img-1",
    fileName: "img-1.png",
    byteSize: 42,
    createdAt: 1,
  };

  const issueItem: GitHubSearchItem = {
    kind: "issue",
    number: 101,
    title: "Fix composer attachments",
    url: "https://github.com/acme/paseo/issues/101",
    state: "open",
    body: "Issue body",
    labels: ["composer"],
    baseRefName: null,
    headRefName: null,
  };

  const prItem: GitHubSearchItem = {
    kind: "pr",
    number: 202,
    title: "Refactor composer attachments",
    url: "https://github.com/acme/paseo/pull/202",
    state: "open",
    body: "PR body",
    labels: ["composer"],
    baseRefName: "main",
    headRefName: "composer-attachments",
  };

  const mockClient = {
    isConnected: true,
    searchGitHub: vi.fn(async () => ({ items: [issueItem, prItem] })),
    sendAgentMessage: vi.fn(async () => {}),
    cancelAgent: vi.fn(async () => {}),
  };

  const setQueuedMessagesMock = vi.fn();
  const mockSessionState: {
    sessions: Record<
      string,
      {
        agents: Map<string, { status: string; lastUsage: null }>;
        queuedMessages: Map<string, unknown[]>;
        agentStreamHead: Map<string, unknown[]>;
        agentStreamTail: Map<string, unknown[]>;
      }
    >;
    setQueuedMessages: ReturnType<typeof vi.fn>;
    setAgentStreamTail?: ReturnType<typeof vi.fn>;
    setAgentStreamHead?: ReturnType<typeof vi.fn>;
  } = {
    sessions: {
      server: {
        agents: new Map([["agent", { status: "idle", lastUsage: null }]]),
        queuedMessages: new Map(),
        agentStreamHead: new Map(),
        agentStreamTail: new Map(),
      },
    },
    setQueuedMessages: setQueuedMessagesMock,
  };
  const setAgentStreamTailMock = vi.fn(
    (serverId: string, updater: (prev: Map<string, unknown[]>) => Map<string, unknown[]>) => {
      const session = mockSessionState.sessions[serverId];
      session.agentStreamTail = updater(session.agentStreamTail);
    },
  );
  const setAgentStreamHeadMock = vi.fn(
    (serverId: string, updater: (prev: Map<string, unknown[]>) => Map<string, unknown[]>) => {
      const session = mockSessionState.sessions[serverId];
      session.agentStreamHead = updater(session.agentStreamHead);
    },
  );
  mockSessionState.setAgentStreamTail = setAgentStreamTailMock;
  mockSessionState.setAgentStreamHead = setAgentStreamHeadMock;

  return {
    theme,
    imageMetadata,
    issueItem,
    prItem,
    mockClient,
    pickImagesMock: vi.fn(),
    persistAttachmentFromBlobMock: vi.fn(async () => imageMetadata),
    deleteAttachmentsMock: vi.fn(async () => {}),
    encodeImagesMock: vi.fn(async (images: AttachmentMetadata[]) => images),
    openExternalUrlMock: vi.fn(async () => {}),
    mockSessionState,
    setAgentStreamTailMock,
    setAgentStreamHeadMock,
    setQueuedMessagesMock,
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
  FOOTER_HEIGHT: 72,
  MAX_CONTENT_WIDTH: 900,
  useIsCompactFormFactor: () => false,
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    ArrowUp: createIcon("ArrowUp"),
    CornerDownLeft: createIcon("CornerDownLeft"),
    Square: createIcon("Square"),
    Pencil: createIcon("Pencil"),
    AudioLines: createIcon("AudioLines"),
    CircleDot: createIcon("CircleDot"),
    GitPullRequest: createIcon("GitPullRequest"),
    X: createIcon("X"),
    Mic: createIcon("Mic"),
    MicOff: createIcon("MicOff"),
    Plus: createIcon("Plus"),
    Paperclip: createIcon("Paperclip"),
    Github: createIcon("Github"),
  };
});

vi.mock("react-native-reanimated", () => ({
  default: {
    View: "div",
  },
  Keyframe: class Keyframe {
    duration() {
      return this;
    }
    withCallback() {
      return this;
    }
  },
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: (factory: () => unknown) => factory(),
  withTiming: (value: unknown) => value,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => mockClient,
  useHostRuntimeIsConnected: () => true,
  useHostRuntimeAgentDirectoryStatus: () => "ready",
}));

vi.mock("@/stores/session-store", () => {
  const useSessionStore = (selector: (state: typeof mockSessionState) => unknown) =>
    selector(mockSessionState);
  useSessionStore.getState = () => mockSessionState;
  return { useSessionStore };
});

vi.mock("@/hooks/use-image-attachment-picker", () => ({
  useImageAttachmentPicker: () => ({ pickImages: pickImagesMock }),
}));

vi.mock("@/attachments/service", () => ({
  persistAttachmentFromBlob: persistAttachmentFromBlobMock,
  persistAttachmentFromFileUri: vi.fn(async () => imageMetadata),
  deleteAttachments: deleteAttachmentsMock,
}));

vi.mock("@/attachments/use-attachment-preview-url", () => ({
  useAttachmentPreviewUrl: () => "blob:preview",
}));

vi.mock("expo-image", () => ({
  Image: (props: Record<string, unknown>) => {
    const source = props.source as { uri?: string } | string | undefined;
    const uri = typeof source === "string" ? source : source?.uri;
    return React.createElement("div", {
      "data-testid": props.testID,
      "data-source": uri,
      role: "img",
    });
  },
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  const Modal = ({
    visible = true,
    children,
  }: {
    visible?: boolean;
    children?: React.ReactNode;
  }) =>
    visible ? React.createElement("div", { "data-testid": "lightbox-modal" }, children) : null;
  return { ...actual, Modal };
});

vi.mock("@/utils/encode-images", () => ({
  encodeImages: encodeImagesMock,
}));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: openExternalUrlMock,
}));

vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => ({ settings: { sendBehavior: "interrupt" } }),
}));

vi.mock("@/hooks/use-agent-autocomplete", () => ({
  useAgentAutocomplete: () => ({
    isVisible: false,
    options: [],
    selectedIndex: -1,
    isLoading: false,
    errorMessage: null,
    loadingText: "",
    emptyText: "",
    onSelectOption: vi.fn(),
    onKeyPress: () => false,
  }),
}));

vi.mock("@/hooks/use-shortcut-keys", () => ({
  useShortcutKeys: () => null,
}));

vi.mock("@/hooks/use-keyboard-action-handler", () => ({
  useKeyboardActionHandler: () => {},
}));

vi.mock("@/hooks/use-keyboard-shift-style", () => ({
  useKeyboardShiftStyle: () => ({ style: {} }),
}));

vi.mock("@/contexts/voice-context", () => ({
  useVoiceOptional: () => null,
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn() }),
}));

vi.mock("@/utils/scroll-jank-investigation", () => ({
  markScrollInvestigationRender: vi.fn(),
  markScrollInvestigationEvent: vi.fn(),
}));

vi.mock("@/components/agent-status-bar", () => ({
  AgentStatusBar: () => null,
  DraftAgentStatusBar: () => null,
}));

vi.mock("@/components/context-window-meter", () => ({
  ContextWindowMeter: () => null,
}));

vi.mock("@/components/composer.status-controls", () => ({
  resolveStatusControlMode: () => "agent",
}));

vi.mock("@/components/ui/autocomplete", () => ({
  Autocomplete: () => null,
}));

vi.mock("@/components/use-web-scrollbar", () => ({
  useWebElementScrollbar: () => null,
}));

vi.mock("@/hooks/use-web-scrollbar-style", () => ({
  useWebScrollbarStyle: () => undefined,
}));

vi.mock("@/hooks/use-dictation", () => ({
  useDictation: () => ({
    isRecording: false,
    isProcessing: false,
    partialTranscript: "",
    volume: 0,
    duration: 0,
    error: null,
    status: "idle",
    startDictation: vi.fn(),
    cancelDictation: vi.fn(),
    confirmDictation: vi.fn(),
    retryFailedDictation: vi.fn(),
    discardFailedDictation: vi.fn(),
  }),
}));

vi.mock("@/utils/server-info-capabilities", () => ({
  resolveVoiceUnavailableMessage: () => null,
}));

vi.mock("@/components/ui/shortcut", () => ({
  Shortcut: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    asChild,
    children,
    onPress,
    accessibilityLabel,
    disabled,
  }: {
    asChild?: boolean;
    children: React.ReactNode | ((state: { hovered: boolean }) => React.ReactNode);
    onPress?: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
  }) =>
    asChild ? (
      <>{children}</>
    ) : (
      <button type="button" aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
        {typeof children === "function" ? children({ hovered: false }) : children}
      </button>
    ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/dropdown-menu", () => {
  const DropdownContext = React.createContext<{
    open: boolean;
    setOpen: (open: boolean) => void;
  } | null>(null);

  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => {
      const [open, setOpen] = React.useState(false);
      return (
        <DropdownContext.Provider value={{ open, setOpen }}>{children}</DropdownContext.Provider>
      );
    },
    DropdownMenuTrigger: ({
      children,
      testID,
      accessibilityLabel,
      disabled,
    }: {
      children:
        | React.ReactNode
        | ((state: { hovered: boolean; pressed: boolean; open: boolean }) => React.ReactNode);
      testID?: string;
      accessibilityLabel?: string;
      disabled?: boolean;
    }) => {
      const menu = React.useContext(DropdownContext);
      return (
        <button
          type="button"
          data-testid={testID}
          aria-label={accessibilityLabel}
          disabled={disabled}
          onClick={() => menu?.setOpen(true)}
        >
          {typeof children === "function"
            ? children({ hovered: false, pressed: false, open: menu?.open ?? false })
            : children}
        </button>
      );
    },
    DropdownMenuContent: ({ children, testID }: { children: React.ReactNode; testID?: string }) => {
      const menu = React.useContext(DropdownContext);
      return menu?.open ? <div data-testid={testID}>{children}</div> : null;
    },
    DropdownMenuItem: ({
      children,
      onSelect,
      testID,
      disabled,
    }: {
      children: React.ReactNode;
      onSelect?: () => void;
      testID?: string;
      disabled?: boolean;
    }) => (
      <button type="button" data-testid={testID} disabled={disabled} onClick={onSelect}>
        {children}
      </button>
    ),
  };
});

vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({
    open,
    options,
    renderOption,
    anchorRef,
  }: {
    open?: boolean;
    options: Array<{ id: string; label: string; description?: string }>;
    renderOption?: (input: {
      option: { id: string; label: string; description?: string };
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => React.ReactElement;
    anchorRef: React.RefObject<unknown>;
  }) =>
    open ? (
      <div
        data-testid="composer-github-combobox"
        data-anchor={anchorRef.current ? "attached" : "missing"}
      >
        {options.map((option) =>
          renderOption ? (
            renderOption({ option, selected: false, active: false, onPress: vi.fn() })
          ) : (
            <button type="button" key={option.id}>
              {option.label}
            </button>
          ),
        )}
      </div>
    ) : null,
  ComboboxItem: ({
    label,
    selected,
    onPress,
    testID,
  }: {
    label: string;
    selected?: boolean;
    onPress: () => void;
    testID?: string;
  }) => (
    <button
      type="button"
      data-testid={testID}
      data-selected={selected ? "true" : "false"}
      onClick={onPress}
    >
      {label}
    </button>
  ),
}));

vi.mock("./dictation-controls", () => ({
  DictationOverlay: () => null,
}));

vi.mock("./realtime-voice-overlay", () => ({
  RealtimeVoiceOverlay: () => null,
}));

let root: Root | null = null;
let container: HTMLElement | null = null;
let queryClient: QueryClient | null = null;
let latestAttachments: ComposerAttachment[] = [];

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("Blob", dom.window.Blob);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  latestAttachments = [];
  mockClient.searchGitHub.mockClear();
  mockClient.sendAgentMessage.mockClear();
  mockClient.cancelAgent.mockClear();
  pickImagesMock.mockReset();
  persistAttachmentFromBlobMock.mockClear();
  deleteAttachmentsMock.mockClear();
  encodeImagesMock.mockClear();
  openExternalUrlMock.mockClear();
  setAgentStreamTailMock.mockClear();
  setAgentStreamHeadMock.mockClear();
  setQueuedMessagesMock.mockClear();
  mockSessionState.sessions.server.agentStreamHead = new Map();
  mockSessionState.sessions.server.agentStreamTail = new Map();
  mockSessionState.sessions.server.queuedMessages = new Map();
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

function imageAttachment(id: string): AttachmentMetadata {
  return {
    ...imageMetadata,
    id,
    storageKey: id,
    fileName: `${id}.png`,
  };
}

function ComposerHarness({
  initialText = "",
  initialAttachments = [],
  isSubmitLoading = false,
  submitBehavior,
}: {
  initialText?: string;
  initialAttachments?: ComposerAttachment[];
  isSubmitLoading?: boolean;
  submitBehavior?: "clear" | "preserve-and-lock";
}) {
  const [text, setText] = useState(initialText);
  const [attachments, setAttachments] = useState(initialAttachments);
  latestAttachments = attachments;

  return (
    <QueryClientProvider client={queryClient!}>
      <Composer
        agentId="agent"
        serverId="server"
        isPaneFocused
        value={text}
        onChangeText={setText}
        attachments={attachments}
        onChangeAttachments={(updater) => {
          setAttachments((current) => {
            const next = typeof updater === "function" ? updater(current) : updater;
            latestAttachments = next;
            return next;
          });
        }}
        isSubmitLoading={isSubmitLoading}
        submitBehavior={submitBehavior}
        cwd="/repo"
        clearDraft={vi.fn()}
      />
    </QueryClientProvider>
  );
}

function renderComposer(
  input: {
    initialText?: string;
    initialAttachments?: ComposerAttachment[];
    isSubmitLoading?: boolean;
    submitBehavior?: "clear" | "preserve-and-lock";
  } = {},
) {
  act(() => {
    root?.render(<ComposerHarness {...input} />);
  });
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function findByTestId(testID: string): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await flushAsyncWork();
    const element = queryByTestId(testID);
    if (element) {
      return element;
    }
  }
  throw new Error(`Missing element with testID ${testID}`);
}

function queryByTestId(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function queryAllAttachmentMenuItems(): NodeListOf<HTMLElement> {
  return document.querySelectorAll('[data-testid^="message-input-attachment-menu-item-"]');
}

describe("Composer attachments", () => {
  it("opens a Plus menu with image and GitHub attachment actions", () => {
    renderComposer();

    click(queryByTestId("message-input-attach-button")!);

    expect(queryAllAttachmentMenuItems()).toHaveLength(2);
    expect(queryByTestId("message-input-attachment-menu-item-image")?.textContent).toBe(
      "Add image",
    );
    expect(queryByTestId("message-input-attachment-menu-item-github")?.textContent).toBe(
      "Add issue or PR",
    );
  });

  it("adds a picked image as a unified composer attachment and renders a pill", async () => {
    pickImagesMock.mockResolvedValue([
      {
        source: { kind: "blob", blob: new Blob(["image"]) },
        mimeType: "image/png",
        fileName: "img-1.png",
      },
    ]);
    renderComposer();

    click(queryByTestId("message-input-attach-button")!);
    click(queryByTestId("message-input-attachment-menu-item-image")!);
    await flushAsyncWork();

    expect(persistAttachmentFromBlobMock).toHaveBeenCalledWith({
      blob: expect.any(Blob),
      mimeType: "image/png",
      fileName: "img-1.png",
    });
    expect(latestAttachments).toEqual([{ kind: "image", metadata: imageMetadata }]);
    expect(queryByTestId("composer-image-attachment-pill")).not.toBeNull();
  });

  it("opens the GitHub combobox from the Plus menu anchored at the Plus button", async () => {
    renderComposer();

    click(queryByTestId("message-input-attach-button")!);
    click(queryByTestId("message-input-attachment-menu-item-github")!);

    const combobox = await findByTestId("composer-github-combobox");
    expect(combobox.dataset.anchor).toBe("attached");
  });

  it("closes the GitHub combobox after selecting an item", async () => {
    renderComposer();

    click(queryByTestId("message-input-attach-button")!);
    click(queryByTestId("message-input-attachment-menu-item-github")!);
    const issueOption = await findByTestId("composer-github-option-issue:101");

    click(issueOption);

    expect(latestAttachments).toEqual([{ kind: "github_issue", item: issueItem }]);
    expect(queryByTestId("composer-github-combobox")).toBeNull();
  });

  it("toggles GitHub search items into and out of unified composer attachments", async () => {
    renderComposer();

    click(queryByTestId("message-input-attach-button")!);
    click(queryByTestId("message-input-attachment-menu-item-github")!);
    const issueOption = await findByTestId("composer-github-option-issue:101");

    click(issueOption);
    expect(latestAttachments).toEqual([{ kind: "github_issue", item: issueItem }]);
    expect(queryByTestId("composer-github-attachment-pill")).not.toBeNull();
    expect(queryByTestId("composer-github-combobox")).toBeNull();

    click(queryByTestId("message-input-attach-button")!);
    click(queryByTestId("message-input-attachment-menu-item-github")!);
    const selectedIssueOption = await findByTestId("composer-github-option-issue:101");
    click(selectedIssueOption);
    expect(latestAttachments).toEqual([]);
    expect(queryByTestId("composer-github-combobox")).toBeNull();
  });

  it("submits mixed composer attachments as the expected wire images and attachments", async () => {
    const image = imageAttachment("img-2");
    renderComposer({
      initialText: "send attachments",
      initialAttachments: [
        { kind: "image", metadata: image },
        { kind: "github_pr", item: prItem },
      ],
    });

    click(document.querySelector('[aria-label="Send message"]')!);
    await flushAsyncWork();

    expect(mockClient.sendAgentMessage).toHaveBeenCalledWith(
      "agent",
      "send attachments",
      expect.objectContaining({
        images: [image],
        attachments: [
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: 202,
            title: "Refactor composer attachments",
            url: "https://github.com/acme/paseo/pull/202",
            body: "PR body",
            baseRefName: "main",
            headRefName: "composer-attachments",
          },
        ],
      }),
    );
  });

  it("submits empty wire arrays when there are no composer attachments", async () => {
    renderComposer({ initialText: "plain message" });

    click(document.querySelector('[aria-label="Send message"]')!);
    await flushAsyncWork();

    expect(mockClient.sendAgentMessage).toHaveBeenCalledWith(
      "agent",
      "plain message",
      expect.objectContaining({
        images: [],
        attachments: [],
      }),
    );
  });

  it("removes the image attachment when its pill X button is pressed", () => {
    const image = imageAttachment("img-remove");
    renderComposer({ initialAttachments: [{ kind: "image", metadata: image }] });

    const removeButton = document.querySelector('[aria-label="Remove image attachment"]');
    expect(removeButton).not.toBeNull();
    click(removeButton!);

    expect(latestAttachments).toEqual([]);
    expect(deleteAttachmentsMock).toHaveBeenCalledWith([image]);
  });

  it("removes a GitHub attachment when its pill X button is pressed", () => {
    renderComposer({ initialAttachments: [{ kind: "github_issue", item: issueItem }] });

    const removeButton = document.querySelector(`[aria-label="Remove issue #${issueItem.number}"]`);
    expect(removeButton).not.toBeNull();
    click(removeButton!);

    expect(latestAttachments).toEqual([]);
  });

  it("opens the GitHub issue URL when the pill body is pressed", () => {
    renderComposer({ initialAttachments: [{ kind: "github_issue", item: issueItem }] });

    click(queryByTestId("composer-github-attachment-pill")!);

    expect(openExternalUrlMock).toHaveBeenCalledWith(issueItem.url);
    expect(latestAttachments).toEqual([{ kind: "github_issue", item: issueItem }]);
  });

  it("opens the GitHub PR URL when the pill body is pressed", () => {
    renderComposer({ initialAttachments: [{ kind: "github_pr", item: prItem }] });

    click(queryByTestId("composer-github-attachment-pill")!);

    expect(openExternalUrlMock).toHaveBeenCalledWith(prItem.url);
    expect(latestAttachments).toEqual([{ kind: "github_pr", item: prItem }]);
  });

  it("opens the image lightbox when the image pill body is pressed", () => {
    const image = imageAttachment("img-body");
    renderComposer({ initialAttachments: [{ kind: "image", metadata: image }] });

    expect(queryByTestId("attachment-lightbox-image")).toBeNull();

    click(queryByTestId("composer-image-attachment-pill")!);

    expect(queryByTestId("attachment-lightbox-image")).not.toBeNull();
    expect(openExternalUrlMock).not.toHaveBeenCalled();
    expect(latestAttachments).toEqual([{ kind: "image", metadata: image }]);
  });

  it("locks the preserved draft while submit loading", () => {
    renderComposer({
      initialText: "keep this prompt",
      initialAttachments: [{ kind: "github_pr", item: prItem }],
      isSubmitLoading: true,
      submitBehavior: "preserve-and-lock",
    });

    const textInput = document.querySelector('[aria-label="Message agent..."]');
    const attachButton = queryByTestId("message-input-attach-button");
    const pill = queryByTestId("composer-github-attachment-pill");
    const removeButton = document.querySelector(`[aria-label="Remove PR #${prItem.number}"]`);

    expect(textInput).toHaveProperty("readOnly", true);
    expect(textInput).toHaveProperty("value", "keep this prompt");
    expect(attachButton).toHaveProperty("disabled", true);
    expect(pill).not.toBeNull();
    expect(removeButton).not.toBeNull();

    click(pill!);
    click(removeButton!);

    expect(openExternalUrlMock).not.toHaveBeenCalled();
    expect(latestAttachments).toEqual([{ kind: "github_pr", item: prItem }]);
  });

  it("closes the image lightbox when its close button is pressed", () => {
    const image = imageAttachment("img-close");
    renderComposer({ initialAttachments: [{ kind: "image", metadata: image }] });

    click(queryByTestId("composer-image-attachment-pill")!);
    expect(queryByTestId("attachment-lightbox-image")).not.toBeNull();

    const closeButton = document.querySelector(
      '[aria-label="Close image"][data-testid="attachment-lightbox-close"]',
    );
    expect(closeButton).not.toBeNull();
    click(closeButton!);

    expect(queryByTestId("attachment-lightbox-image")).toBeNull();
  });

  it("splits mixed composer attachments only at the submit wire boundary", () => {
    const image = imageAttachment("img-3");

    expect(
      splitComposerAttachmentsForSubmit([
        { kind: "image", metadata: image },
        { kind: "github_issue", item: issueItem },
        { kind: "github_pr", item: prItem },
      ]),
    ).toEqual({
      images: [image],
      attachments: [
        {
          type: "github_issue",
          mimeType: "application/github-issue",
          number: 101,
          title: "Fix composer attachments",
          url: "https://github.com/acme/paseo/issues/101",
          body: "Issue body",
        },
        {
          type: "github_pr",
          mimeType: "application/github-pr",
          number: 202,
          title: "Refactor composer attachments",
          url: "https://github.com/acme/paseo/pull/202",
          body: "PR body",
          baseRefName: "main",
          headRefName: "composer-attachments",
        },
      ],
    });
  });
});
