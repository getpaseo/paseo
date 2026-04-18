import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput, type AttachmentMenuItem } from "./message-input";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    iconSize: { sm: 14, md: 18, lg: 22 },
    borderWidth: { 1: 1 },
    borderRadius: { full: 999, md: 6, lg: 8, "2xl": 16 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400" },
    shadow: { md: {} },
    colors: {
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      surface4: "#888",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      popoverForeground: "#fff",
      borderAccent: "#444",
      accent: "#0a84ff",
      accentForeground: "#fff",
      destructive: "#ff453a",
      palette: {
        green: { 500: "#30d158" },
      },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("@/constants/platform", () => ({
  isWeb: false,
  isNative: true,
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    ArrowUp: createIcon("ArrowUp"),
    Mic: createIcon("Mic"),
    MicOff: createIcon("MicOff"),
    CornerDownLeft: createIcon("CornerDownLeft"),
    Plus: createIcon("Plus"),
    Square: createIcon("Square"),
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

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: { sessions: Record<string, unknown> }) => unknown) =>
    selector({ sessions: {} }),
}));

vi.mock("@/contexts/voice-context", () => ({
  useVoiceOptional: () => null,
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn() }),
}));

vi.mock("@/utils/server-info-capabilities", () => ({
  resolveVoiceUnavailableMessage: () => null,
}));

vi.mock("@/components/use-web-scrollbar", () => ({
  useWebElementScrollbar: () => null,
}));

vi.mock(
  "@/hooks/use-web-scrollbar-style",
  () => ({
    useWebScrollbarStyle: () => undefined,
  }),
  // @ts-expect-error Vitest accepts virtual mocks at runtime; the app's types omit this overload.
  { virtual: true },
);

vi.mock("@/hooks/use-shortcut-keys", () => ({
  useShortcutKeys: () => null,
}));

vi.mock("@/components/ui/shortcut", () => ({
  Shortcut: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    asChild,
    children,
    ...props
  }: {
    asChild?: boolean;
    children: React.ReactNode | ((state: { hovered: boolean }) => React.ReactNode);
  } & Record<string, any>) =>
    asChild ? (
      <>{children}</>
    ) : (
      <button type="button" aria-label={props.accessibilityLabel}>
        {typeof children === "function" ? children({ hovered: false }) : children}
      </button>
    ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({
    children,
    testID,
    accessibilityLabel,
  }: {
    children:
      | React.ReactNode
      | ((state: { hovered: boolean; pressed: boolean; open: boolean }) => React.ReactNode);
    testID?: string;
    accessibilityLabel?: string;
  }) => (
    <button type="button" data-testid={testID} aria-label={accessibilityLabel}>
      {typeof children === "function"
        ? children({ hovered: false, pressed: false, open: false })
        : children}
    </button>
  ),
  DropdownMenuContent: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
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
}));

vi.mock("./dictation-controls", () => ({
  DictationOverlay: () => null,
}));

vi.mock("./realtime-voice-overlay", () => ({
  RealtimeVoiceOverlay: () => null,
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

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
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

interface RenderMessageInputOptions {
  value?: string;
  submitIcon?: "arrow" | "return";
}

function renderMessageInput(
  menuItems: AttachmentMenuItem[],
  { value = "", submitIcon }: RenderMessageInputOptions = {},
) {
  act(() => {
    root?.render(
      <MessageInput
        value={value}
        onChangeText={vi.fn()}
        onSubmit={vi.fn()}
        attachments={[]}
        cwd="/repo"
        attachmentMenuItems={menuItems}
        client={{ isConnected: true } as never}
        isAgentRunning={false}
        submitIcon={submitIcon}
        onQueue={vi.fn()}
      />,
    );
  });
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

function queryByTestId(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function queryAllByAriaLabel(label: string): NodeListOf<HTMLElement> {
  return document.querySelectorAll(`[aria-label="${label}"]`);
}

describe("MessageInput attachments", () => {
  it("renders the Plus attachment button and opens a menu with two attachment items", () => {
    const menuItems: AttachmentMenuItem[] = [
      { id: "image", label: "Add image", onSelect: vi.fn() },
      { id: "github", label: "Add issue or PR", onSelect: vi.fn() },
    ];

    renderMessageInput(menuItems);

    expect(document.querySelectorAll('[data-icon="Plus"]')).toHaveLength(1);

    const attachButton = queryByTestId("message-input-attach-button");
    expect(attachButton).not.toBeNull();
    click(attachButton!);

    expect(queryByTestId("message-input-attachment-menu-item-image")).not.toBeNull();
    expect(queryByTestId("message-input-attachment-menu-item-github")).not.toBeNull();
    expect(
      document.querySelectorAll('[data-testid^="message-input-attachment-menu-item-"]'),
    ).toHaveLength(2);
  });

  it("selecting Attach image invokes the supplied image attachment action", () => {
    const attachImage = vi.fn();

    renderMessageInput([
      { id: "image", label: "Attach image", onSelect: attachImage },
      { id: "github", label: "Attach GitHub issue or PR", onSelect: vi.fn() },
    ]);

    click(queryByTestId("message-input-attach-button")!);
    click(queryByTestId("message-input-attachment-menu-item-image")!);

    expect(attachImage).toHaveBeenCalledTimes(1);
  });

  it("does not render the old queue button", () => {
    renderMessageInput([
      { id: "image", label: "Add image", onSelect: vi.fn() },
      { id: "github", label: "Add issue or PR", onSelect: vi.fn() },
    ]);

    expect(queryAllByAriaLabel("Queue message")).toHaveLength(0);
  });

  it("uses ArrowUp by default and CornerDownLeft when return submit icon is requested", () => {
    renderMessageInput([], { value: "Send this" });

    expect(document.querySelectorAll('[data-icon="ArrowUp"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-icon="CornerDownLeft"]')).toHaveLength(0);

    renderMessageInput([], { value: "Create this", submitIcon: "return" });

    expect(document.querySelectorAll('[data-icon="ArrowUp"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-icon="CornerDownLeft"]')).toHaveLength(1);
  });
});
