import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import { AttachmentLightbox } from "./attachment-lightbox";

const { theme, imageMetadata, useAttachmentPreviewUrlMock } = vi.hoisted(() => {
  const theme = {
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

  const imageMetadata: AttachmentMetadata = {
    id: "img-1",
    mimeType: "image/png",
    storageType: "web-indexeddb",
    storageKey: "img-1",
    fileName: "img-1.png",
    byteSize: 42,
    createdAt: 1,
  };

  return {
    theme,
    imageMetadata,
    useAttachmentPreviewUrlMock: vi.fn<(metadata: AttachmentMetadata | null) => string | null>(
      () => "blob:preview",
    ),
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

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    X: createIcon("X"),
  };
});

vi.mock("expo-image", () => ({
  Image: (props: Record<string, unknown>) => {
    const source = props.source as { uri?: string } | string | undefined;
    const uri = typeof source === "string" ? source : source?.uri;
    return React.createElement("div", {
      "data-testid": props.testID,
      "data-source": uri,
      "data-style": JSON.stringify(props.style ?? null),
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

vi.mock("@/attachments/use-attachment-preview-url", () => ({
  useAttachmentPreviewUrl: (metadata: AttachmentMetadata | null) =>
    useAttachmentPreviewUrlMock(metadata),
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

function queryByTestId(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

describe("AttachmentLightbox", () => {
  it("renders nothing when metadata is null", () => {
    render(<AttachmentLightbox metadata={null} onClose={vi.fn()} />);

    expect(queryByTestId("attachment-lightbox-backdrop")).toBeNull();
    expect(queryByTestId("attachment-lightbox-image")).toBeNull();
  });

  it("renders the image when metadata is provided", () => {
    render(<AttachmentLightbox metadata={imageMetadata} onClose={vi.fn()} />);

    const image = queryByTestId("attachment-lightbox-image");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("data-source")).toBe("blob:preview");
  });

  it("fills its parent via absolute positioning so expo-image does not collapse to 0px", () => {
    render(<AttachmentLightbox metadata={imageMetadata} onClose={vi.fn()} />);

    const image = queryByTestId("attachment-lightbox-image");
    const style = JSON.parse(image?.getAttribute("data-style") ?? "null") as {
      position?: string;
      top?: number;
      left?: number;
      right?: number;
      bottom?: number;
    } | null;
    expect(style?.position).toBe("absolute");
    expect(style?.top).toBe(0);
    expect(style?.left).toBe(0);
    expect(style?.right).toBe(0);
    expect(style?.bottom).toBe(0);
  });

  it("calls onClose when the backdrop is pressed", () => {
    const onClose = vi.fn();
    render(<AttachmentLightbox metadata={imageMetadata} onClose={onClose} />);

    const backdrop = queryByTestId("attachment-lightbox-backdrop");
    expect(backdrop).not.toBeNull();
    click(backdrop!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the close button is pressed", () => {
    const onClose = vi.fn();
    render(<AttachmentLightbox metadata={imageMetadata} onClose={onClose} />);

    const closeButton = document.querySelector(
      '[aria-label="Close image"][data-testid="attachment-lightbox-close"]',
    );
    expect(closeButton).not.toBeNull();
    click(closeButton!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows error text when the preview URL resolves to null", () => {
    useAttachmentPreviewUrlMock.mockReturnValue(null);
    render(<AttachmentLightbox metadata={imageMetadata} onClose={vi.fn()} />);

    expect(queryByTestId("attachment-lightbox-image")).toBeNull();
    expect(document.body.textContent ?? "").toContain("Couldn't load image");
  });

  it("closes on Escape key on web", () => {
    const onClose = vi.fn();
    render(<AttachmentLightbox metadata={imageMetadata} onClose={onClose} />);

    act(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
