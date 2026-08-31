import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MermaidFullscreenViewer } from "./fullscreen-viewer.web";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
    colors: { surface0: "#000", surface2: "#222", foreground: "#fff", foregroundMuted: "#aaa" },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => ({ "common.actions.close": "Close" })[key] ?? key,
  }),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock("@/utils/desktop-window", () => ({
  WindowChromeRootRegion: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock("lucide-react-native", () => ({
  X: (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": "X" }),
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  const Modal = ({ visible = true, children }: { visible?: boolean; children?: React.ReactNode }) =>
    visible ? React.createElement("div", { "data-testid": "mermaid-modal" }, children) : null;
  return { ...actual, Modal };
});

vi.mock("@/components/zoomable-viewport", () => ({
  ZoomableViewport: (props: Record<string, unknown>) => {
    const actions = props.actions as Array<{ label: string; onPress: () => void; testID?: string }>;
    const contentSize = props.contentSize as { width: number; height: number };
    return React.createElement(
      "div",
      {
        "data-testid": String(props.testID),
        "data-content-size": `${contentSize.width}x${contentSize.height}`,
      },
      React.createElement("button", {
        "data-testid": "press-outside-content",
        onClick: props.onPressOutsideContent as () => void,
        type: "button",
      }),
      actions.map((action) =>
        React.createElement(
          "button",
          {
            "aria-label": action.label,
            "data-testid": action.testID,
            key: action.label,
            onClick: action.onPress,
            type: "button",
          },
          action.label,
        ),
      ),
      props.children as React.ReactNode,
    );
  },
}));

vi.mock("./iframe-runtime.web", () => ({
  MermaidIframeRuntime: (props: Record<string, unknown>) => {
    const request = props.request as {
      revision: number;
      source: string;
      colorScheme: "light" | "dark";
    } | null;
    const onRendered = props.onRendered as (message: Record<string, unknown>) => void;
    return React.createElement("button", {
      "data-testid": "iframe-runtime",
      "data-request": request ? String(request.revision) : "none",
      disabled: !request,
      onClick: () =>
        request &&
        onRendered({
          revision: request.revision,
          source: request.source,
          colorScheme: request.colorScheme,
          width: 800,
          height: 400,
        }),
      type: "button",
    });
  },
}));

const DIAGRAM_SOURCE = "flowchart LR\n  Start --> Ship";

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

function render(element: React.ReactElement) {
  act(() => {
    root?.render(element);
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

function renderViewer(onClose = vi.fn()) {
  render(<MermaidFullscreenViewer source={DIAGRAM_SOURCE} colorScheme="dark" onClose={onClose} />);
  return onClose;
}

describe("MermaidFullscreenViewer", () => {
  it("renders the diagram in a fullscreen viewport", () => {
    renderViewer();

    expect(queryByTestId("mermaid-modal")).not.toBeNull();
    expect(queryByTestId("mermaid-fullscreen-viewport")).not.toBeNull();
    expect(queryByTestId("iframe-runtime")?.getAttribute("data-request")).toBe("1");
  });

  it("sizes the viewport to the rendered diagram", () => {
    renderViewer();

    click(queryByTestId("iframe-runtime")!);

    expect(queryByTestId("mermaid-fullscreen-viewport")?.getAttribute("data-content-size")).toBe(
      "800x400",
    );
  });

  it("closes from the toolbar action", () => {
    const onClose = renderViewer();

    click(queryByTestId("mermaid-fullscreen-close")!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the area outside the diagram is pressed", () => {
    const onClose = renderViewer();

    click(queryByTestId("press-outside-content")!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = renderViewer();

    act(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
