import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Combobox } from "./combobox";

const { theme } = vi.hoisted(() => {
  const anyValue: object = new Proxy(() => 0, {
    get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : anyValue),
  });
  return { theme: anyValue };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: () => new Proxy({}, { get: () => ({}) }),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("@/constants/platform", () => ({
  isWeb: false,
  isNative: true,
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "gesture-handler-root" }, children),
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  const Modal = ({ visible = true, children }: { visible?: boolean; children?: React.ReactNode }) =>
    visible ? React.createElement("div", { "data-testid": "native-modal" }, children) : null;
  return { ...actual, Modal };
});

vi.mock("@floating-ui/react-native", () => ({
  useFloating: () => ({
    refs: { setFloating: () => {}, setOffsetParent: () => {}, setReference: () => {} },
    floatingStyles: { position: "absolute", top: 0, left: 0 },
    update: () => {},
  }),
  flip: () => ({}),
  offset: () => ({}),
  shift: () => ({}),
  size: () => ({}),
}));

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));

vi.mock("@gorhom/bottom-sheet", () => ({
  BottomSheetScrollView: "div",
  BottomSheetBackdrop: "div",
}));

vi.mock("lucide-react-native", () => ({
  Check: "span",
  File: "span",
  Folder: "span",
  Search: "span",
}));

vi.mock("./isolated-bottom-sheet-modal", () => ({
  IsolatedBottomSheetModal: () => null,
  useIsolatedBottomSheetVisibility: () => ({
    sheetRef: { current: null },
    handleSheetChange: () => {},
    handleSheetDismiss: () => {},
  }),
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveTextInput: () => null,
  InlineHeaderView: () => null,
  SheetHeaderView: () => null,
}));

vi.mock("@/components/ui/floating", () => ({
  FloatingSurface: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
}));

vi.mock("@/components/ui/keyboard-dismiss", () => ({
  useDismissKeyboardOnOpen: () => {},
}));

vi.mock("@/lib/overlay-root", () => ({
  getOverlayRoot: () => document.body,
  OverlayLayerProvider: ({ children }: { children?: React.ReactNode }) => children,
  useOverlayLayer: () => 1,
  useWebOverlayRegistration: () => () => {},
}));

const anchorRef = { current: null };

let root: Root | null = null;

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

  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  vi.unstubAllGlobals();
});

describe("Combobox on native non-compact layouts", () => {
  it("gives the popover's native Modal its own gesture handler root", () => {
    // Android renders a Modal in a separate window, outside the app's root
    // GestureHandlerRootView. RNGH gestures in the popover (the model
    // browser's rows on tablets) only fire under a root inside the Modal.
    act(() => {
      root?.render(
        <Combobox options={[]} value="" onSelect={vi.fn()} open anchorRef={anchorRef}>
          <View testID="popover-row" />
        </Combobox>,
      );
    });

    const modal = document.querySelector('[data-testid="native-modal"]');
    expect(modal?.querySelector('[data-testid="combobox-desktop-container"]')).not.toBeNull();
    const gestureRoot = modal?.querySelector('[data-testid="gesture-handler-root"]');
    expect(gestureRoot).not.toBeNull();
    expect(gestureRoot?.querySelector('[data-testid="combobox-desktop-container"]')).not.toBeNull();
    expect(gestureRoot?.querySelector('[data-testid="popover-row"]')).not.toBeNull();
  });
});
