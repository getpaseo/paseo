/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplorerFile } from "@/stores/session-store";
import { FilePane } from "@/components/file-pane";
import {
  PaneFocusProvider,
  PaneProvider,
  createPaneFocusContextValue,
  type PaneContextValue,
} from "@/panels/pane-context";
import {
  clearActivePaneFindPaneId,
  handlePaneFindKeyboardAction,
  setActivePaneFindPaneId,
} from "@/panels/pane-find-registry";

const { queryState, theme } = vi.hoisted(() => ({
  queryState: {
    current: {
      data: null as null | {
        error: string | null;
        file: ExplorerFile | null;
        imageAttachment?: unknown;
      },
      isFetching: false,
    },
  },
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    fontSize: { sm: 13 },
    colors: {
      destructive: "#f43f5e",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      primary: "#0a84ff",
      surface0: "#111",
      surface1: "#222",
      surface2: "#333",
    },
    colorScheme: "dark",
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState.current,
}));

vi.mock("react-native", () => {
  const MockView = React.forwardRef<
    HTMLDivElement,
    { children?: React.ReactNode; testID?: string }
  >(function View({ children, testID }, ref) {
    return React.createElement("div", { "data-testid": testID, ref }, children);
  });
  const MockScrollView = React.forwardRef<
    HTMLDivElement,
    { children?: React.ReactNode; horizontal?: boolean }
  >(function ScrollView({ children, horizontal }, ref) {
    return React.createElement(
      "div",
      { "data-horizontal": horizontal ? "true" : undefined, ref },
      children,
    );
  });
  const MockText = ({
    children,
    style,
  }: {
    children?: React.ReactNode;
    style?: React.CSSProperties;
  }) => React.createElement("span", { style }, children);
  const MockPressable = ({
    children,
    disabled,
    onPress,
    testID,
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        "data-testid": testID,
        disabled,
        onClick: () => {
          if (!disabled) {
            onPress?.();
          }
        },
        type: "button",
      },
      children,
    );
  const MockTextInput = React.forwardRef<
    HTMLInputElement,
    {
      value?: string;
      onChangeText?: (text: string) => void;
      onKeyPress?: (event: {
        nativeEvent: { key: string; shiftKey?: boolean };
        preventDefault: () => void;
      }) => void;
      testID?: string;
      placeholder?: string;
    }
  >(function TextInput({ value, onChangeText, onKeyPress, testID, placeholder }, ref) {
    return React.createElement("input", {
      "data-testid": testID,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onChangeText?.(event.currentTarget.value),
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) =>
        onKeyPress?.({
          nativeEvent: { key: event.key, shiftKey: event.shiftKey },
          preventDefault: () => event.preventDefault(),
        }),
      placeholder,
      ref,
      value: value ?? "",
    });
  });
  const MockImage = ({ source }: { source?: { uri?: string } }) =>
    React.createElement("img", { alt: "", src: source?.uri ?? "" });

  return {
    ActivityIndicator: () => React.createElement("span", { "data-testid": "activity" }),
    Image: MockImage,
    Platform: {
      OS: "web",
      select: (options: Record<string, unknown>) => options.web ?? options.default,
    },
    Pressable: MockPressable,
    ScrollView: MockScrollView,
    Text: MockText,
    TextInput: MockTextInput,
    View: MockView,
  };
});

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) =>
    function Icon() {
      return React.createElement("span", { "data-icon": name });
    };
  return {
    ChevronDown: createIcon("ChevronDown"),
    ChevronUp: createIcon("ChevronUp"),
    X: createIcon("X"),
  };
});

vi.mock("react-native-markdown-display", () => ({
  default: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("article", { "data-testid": "markdown-preview" }, children),
  MarkdownIt: () => ({}),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("@/attachments/use-attachment-preview-url", () => ({
  useAttachmentPreviewUrl: (metadata: unknown) => (metadata ? "blob:preview" : null),
}));

vi.mock("@/components/use-web-scrollbar", () => ({
  useWebScrollViewScrollbar: () => ({
    onContentSizeChange: vi.fn(),
    onLayout: vi.fn(),
    onScroll: vi.fn(),
    overlay: null,
  }),
}));

vi.mock("@/hooks/use-web-scrollbar-style", () => ({
  useWebScrollbarStyle: () => ({}),
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
}));

vi.mock("@/styles/markdown-styles", () => ({
  createMarkdownStyles: () => ({}),
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) => selector({ sessions: {} }),
}));

let root: Root | null = null;
let container: HTMLElement | null = null;
const paneInstanceId = "server:workspace:file";
const paneContext: PaneContextValue = {
  serverId: "server",
  workspaceId: "workspace",
  paneInstanceId,
  tabId: "file",
  target: { kind: "file", path: "src/example.ts" },
  openTab: () => {},
  closeCurrentTab: () => {},
  retargetCurrentTab: () => {},
  openFileInWorkspace: () => {},
};
const paneFocus = createPaneFocusContextValue({
  isPaneFocused: true,
  isWorkspaceFocused: true,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
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
  clearActivePaneFindPaneId(paneInstanceId);
  root = null;
  container?.remove();
  container = null;
  queryState.current = { data: null, isFetching: false };
  vi.unstubAllGlobals();
});

function renderFilePane(filePath = "src/example.ts") {
  act(() => {
    root?.render(
      <PaneProvider value={paneContext}>
        <PaneFocusProvider value={paneFocus}>
          <FilePane serverId="server" workspaceRoot="/repo" filePath={filePath} />
        </PaneFocusProvider>
      </PaneProvider>,
    );
  });
  setActivePaneFindPaneId(paneInstanceId);
}

function inputElement(): HTMLInputElement {
  const input = container?.querySelector('[data-testid="pane-find-input"]');
  expect(input).toBeInstanceOf(HTMLInputElement);
  return input as HTMLInputElement;
}

function changeInput(value: string): void {
  const input = inputElement();
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function click(testId: string): void {
  const element = container?.querySelector(`[data-testid="${testId}"]`);
  expect(element).toBeInstanceOf(HTMLElement);
  act(() => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function makeFile(file: Partial<ExplorerFile>): ExplorerFile {
  return {
    content: "",
    encoding: "utf-8",
    kind: "text",
    modifiedAt: "2026-05-02T00:00:00.000Z",
    path: file.path ?? "src/example.ts",
    size: file.size ?? 0,
    ...file,
  };
}

describe("FilePane preview rendering", () => {
  it("renders code/text previews with line numbers and highlighted token text", () => {
    queryState.current = {
      data: {
        error: null,
        file: makeFile({ content: "const answer = 42;\nconsole.log(answer);" }),
      },
      isFetching: false,
    };

    renderFilePane();

    const text = container?.textContent ?? "";
    expect(text).toContain("1");
    expect(text).toContain("2");
    expect(text).toContain("const answer = 42;");
    expect(text).toContain("console.log(answer);");
  });

  it("keeps markdown files on the markdown preview path", () => {
    queryState.current = {
      data: {
        error: null,
        file: makeFile({ content: "# Guide", path: "README.md" }),
      },
      isFetching: false,
    };

    renderFilePane("README.md");

    expect(container?.querySelector('[data-testid="markdown-preview"]')?.textContent).toBe(
      "# Guide",
    );
  });

  it("renders image previews from the attachment preview URL", () => {
    queryState.current = {
      data: {
        error: null,
        file: makeFile({ content: undefined, encoding: "none", kind: "image", path: "logo.png" }),
        imageAttachment: { id: "preview" },
      },
      isFetching: false,
    };

    renderFilePane("logo.png");

    expect(container?.querySelector("img")?.getAttribute("src")).toBe("blob:preview");
  });

  it("keeps binary previews on the unavailable state with file size", () => {
    queryState.current = {
      data: {
        error: null,
        file: makeFile({
          content: undefined,
          encoding: "none",
          kind: "binary",
          path: "tool",
          size: 2048,
        }),
      },
      isFetching: false,
    };

    renderFilePane("tool");

    expect(container?.textContent).toContain("Binary preview unavailable");
    expect(container?.textContent).toContain("2.0 KB");
  });

  it("searches code/text previews case-insensitively and navigates matches", () => {
    queryState.current = {
      data: {
        error: null,
        file: makeFile({ content: "const answer = 42;\nconsole.log(ANSWER);" }),
      },
      isFetching: false,
    };
    renderFilePane();

    act(() => {
      handlePaneFindKeyboardAction({ id: "workspace.find.open", scope: "workspace" });
    });
    changeInput("answer");

    expect(container?.textContent).toContain("1 / 2");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(container?.querySelectorAll('span[style*="background-color"]').length).toBeGreaterThan(
      0,
    );

    click("pane-find-next");
    expect(container?.textContent).toContain("2 / 2");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(2);

    click("pane-find-prev");
    expect(container?.textContent).toContain("1 / 2");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(3);
  });

  it("clears file highlights on empty query and close", () => {
    queryState.current = {
      data: {
        error: null,
        file: makeFile({ content: "needle\nneedle" }),
      },
      isFetching: false,
    };
    renderFilePane();

    act(() => {
      handlePaneFindKeyboardAction({ id: "workspace.find.open", scope: "workspace" });
    });
    changeInput("needle");
    expect(container?.textContent).toContain("1 / 2");

    changeInput("");
    expect(container?.textContent).toContain("0 / 0");
    expect(container?.querySelectorAll('span[style*="background-color"]').length).toBe(0);

    changeInput("needle");
    click("pane-find-close");
    expect(container?.querySelector('[data-testid="pane-find-input"]')).toBeNull();
    expect(container?.querySelectorAll('span[style*="background-color"]').length).toBe(0);
  });
});
