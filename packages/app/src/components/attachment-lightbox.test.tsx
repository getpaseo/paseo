import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import { AttachmentLightbox, type ImageLightboxSource } from "./attachment-lightbox";

const { theme, imageMetadata, useAttachmentPreviewUrlMock } = vi.hoisted(() => {
  const hoistedTheme = {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    iconSize: { sm: 14, md: 18, lg: 22 },
    borderWidth: { 1: 1 },
    borderRadius: { full: 999, md: 6, lg: 8 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400" },
    colors: {
      surface1: "#111",
      surface2: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      borderAccent: "#444",
    },
  };

  const hoistedImageMetadata: AttachmentMetadata = {
    id: "img-1",
    mimeType: "image/png",
    storageType: "web-indexeddb",
    storageKey: "img-1",
    fileName: "img-1.png",
    byteSize: 42,
    createdAt: 1,
  };

  return {
    theme: hoistedTheme,
    imageMetadata: hoistedImageMetadata,
    useAttachmentPreviewUrlMock: vi.fn<(metadata: AttachmentMetadata | null) => string | null>(
      () => "blob:preview",
    ),
  };
});
const attachmentSource: ImageLightboxSource = { type: "attachment", metadata: imageMetadata };
const assistantImageSource: ImageLightboxSource = {
  type: "uri",
  uri: "blob:assistant-image",
};

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

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      ({
        "message.attachments.closeImage": "Close image",
        "message.attachments.dismissImage": "Dismiss image",
        "message.attachments.imageLoadFailed": "Couldn't load image",
        "message.attachments.previousImage": "Previous image",
        "message.attachments.nextImage": "Next image",
        "message.attachments.imagePosition": `${values?.current} / ${values?.total}`,
      })[key] ?? key,
  }),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "gesture-handler-root" }, children),
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    ChevronLeft: createIcon("ChevronLeft"),
    ChevronRight: createIcon("ChevronRight"),
    X: createIcon("X"),
  };
});

vi.mock("@/components/zoomable-viewport/image", () => ({
  ZoomableImage: (props: Record<string, unknown>) => {
    const actions = props.actions as Array<{
      label: string;
      onPress: () => void;
      testID?: string;
    }>;
    return React.createElement(
      "div",
      {
        "data-testid": `${String(props.testID)}-image`,
        "data-source": props.uri,
        role: "img",
      },
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
    );
  },
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  const Modal = ({ visible = true, children }: { visible?: boolean; children?: React.ReactNode }) =>
    visible ? React.createElement("div", { "data-testid": "lightbox-modal" }, children) : null;
  return { ...actual, Modal };
});

vi.mock("@/attachments/use-attachment-preview-url", () => ({
  useAttachmentPreviewUrl: (metadata: AttachmentMetadata | null) =>
    useAttachmentPreviewUrlMock(metadata),
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  dom.window.requestAnimationFrame = vi.fn(() => 1);
  dom.window.cancelAnimationFrame = vi.fn();
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
  useAttachmentPreviewUrlMock.mockReturnValue("blob:preview");
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

function pagingProps(index: number, count: number, onSelect: (index: number) => void) {
  return { index, count, onSelect };
}

function queryByTestId(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

describe("AttachmentLightbox", () => {
  it("renders nothing when the source is null", () => {
    render(<AttachmentLightbox source={null} onClose={vi.fn()} />);

    expect(queryByTestId("attachment-lightbox-backdrop")).toBeNull();
    expect(queryByTestId("attachment-lightbox-image")).toBeNull();
  });

  it("renders the image when metadata is provided", () => {
    render(<AttachmentLightbox source={attachmentSource} onClose={vi.fn()} />);

    const image = queryByTestId("attachment-lightbox-image");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("data-source")).toBe("blob:preview");
  });

  it("renders a direct timeline image without resolving attachment storage", () => {
    render(<AttachmentLightbox source={assistantImageSource} onClose={vi.fn()} />);

    const image = queryByTestId("attachment-lightbox-image");
    expect(image?.getAttribute("data-source")).toBe("blob:assistant-image");
    expect(useAttachmentPreviewUrlMock).toHaveBeenLastCalledWith(null);
  });

  it("calls onClose when the backdrop is pressed", () => {
    const onClose = vi.fn();
    render(<AttachmentLightbox source={attachmentSource} onClose={onClose} />);

    const backdrop = queryByTestId("attachment-lightbox-backdrop");
    expect(backdrop).not.toBeNull();
    click(backdrop!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the close button is pressed", () => {
    const onClose = vi.fn();
    render(<AttachmentLightbox source={attachmentSource} onClose={onClose} />);

    const closeButton = document.querySelector(
      '[aria-label="Close image"][data-testid="attachment-lightbox-close"]',
    );
    expect(closeButton).not.toBeNull();
    click(closeButton!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows error text when the preview URL resolves to null", () => {
    useAttachmentPreviewUrlMock.mockReturnValue(null);
    render(<AttachmentLightbox source={attachmentSource} onClose={vi.fn()} />);

    expect(queryByTestId("attachment-lightbox-image")).toBeNull();
    expect(document.body.textContent ?? "").toContain("Couldn't load image");
  });

  it("shows no paging controls for a single image", () => {
    render(<AttachmentLightbox source={attachmentSource} onClose={vi.fn()} title="img-1.png" />);

    expect(queryByTestId("attachment-lightbox-previous")).toBeNull();
    expect(queryByTestId("attachment-lightbox-next")).toBeNull();
    expect(queryByTestId("attachment-lightbox-caption")?.textContent).toBe("img-1.png");
  });

  it("pages with the buttons and shows the position", () => {
    const onSelect = vi.fn();
    render(
      <AttachmentLightbox
        source={assistantImageSource}
        onClose={vi.fn()}
        title="second.png"
        paging={pagingProps(1, 3, onSelect)}
      />,
    );

    expect(queryByTestId("attachment-lightbox-caption")?.textContent).toBe("second.png2 / 3");
    click(queryByTestId("attachment-lightbox-previous")!);
    click(queryByTestId("attachment-lightbox-next")!);
    expect(onSelect.mock.calls).toEqual([[0], [2]]);
  });

  it("disables paging past either end", () => {
    const onSelect = vi.fn();
    render(
      <AttachmentLightbox
        source={assistantImageSource}
        onClose={vi.fn()}
        paging={pagingProps(0, 2, onSelect)}
      />,
    );

    expect(queryByTestId("attachment-lightbox-previous")?.getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(queryByTestId("attachment-lightbox-next")?.getAttribute("aria-disabled")).toBeNull();
    click(queryByTestId("attachment-lightbox-previous")!);
    expect(onSelect).not.toHaveBeenCalled();
    expect(queryByTestId("attachment-lightbox-caption")?.textContent).toBe("1 / 2");
  });

  it("pages with the arrow keys on web and still closes on Escape", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <AttachmentLightbox
        source={assistantImageSource}
        onClose={onClose}
        paging={pagingProps(1, 3, onSelect)}
      />,
    );

    act(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight" }));
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft" }));
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(onSelect.mock.calls).toEqual([[2], [0]]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores the arrow keys without paging", () => {
    const onClose = vi.fn();
    render(<AttachmentLightbox source={assistantImageSource} onClose={onClose} />);

    act(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight" }));
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(queryByTestId("attachment-lightbox-caption")).toBeNull();
  });

  it("closes on Escape key on web", () => {
    const onClose = vi.fn();
    render(<AttachmentLightbox source={attachmentSource} onClose={onClose} />);

    act(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
