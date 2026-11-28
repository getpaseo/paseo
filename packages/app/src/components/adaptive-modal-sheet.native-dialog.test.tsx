/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme, sheetProps } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
    fontSize: { xs: 11, sm: 13, base: 15, lg: 17 },
    fontWeight: { normal: 400, medium: 500, semibold: 600 },
    borderRadius: { md: 6, lg: 8, xl: 12, full: 999 },
    borderWidth: { 1: 1 },
    colors: {
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
    },
  },
  sheetProps: { current: null as Record<string, unknown> | null },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
  withUnistyles: (component: unknown) => component,
}));
vi.mock("@/constants/platform", () => ({ isWeb: false, isNative: true }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("@/hooks/use-keyboard-visibility", () => ({ useKeyboardVisibility: () => false }));
vi.mock("@gorhom/bottom-sheet", () => ({ BottomSheetHandle: () => null }));
vi.mock("@/components/adaptive-text-input", () => ({ AdaptiveTextInput: () => null }));
vi.mock("@/components/ui/isolated-bottom-sheet-modal", () => ({
  IsolatedBottomSheetModal: React.forwardRef(
    (props: Record<string, unknown> & { children?: React.ReactNode }, _ref) => {
      sheetProps.current = props;
      return React.createElement("div", { "data-native-dialog-sheet": true }, props.children);
    },
  ),
  useIsolatedBottomSheetVisibility: () => ({
    sheetRef: { current: null },
    handleSheetChange: () => {},
    handleSheetDismiss: () => {},
  }),
}));

import { AdaptiveModalSheet } from "./adaptive-modal-sheet";

const HEADER = { title: "Filters" };
const noop = () => {};

describe("AdaptiveModalSheet native dialog (tablet)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    sheetProps.current = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("dims with the sheet's fading backdrop instead of painting the dim on the sliding content", () => {
    act(() => {
      root.render(
        <AdaptiveModalSheet header={HEADER} visible onClose={noop} testID="dialog">
          <div />
        </AdaptiveModalSheet>,
      );
    });

    expect(sheetProps.current?.backdropOpacity).toBe(0.55);
    const overlay = container.querySelector('[data-testid="dialog"]') as HTMLElement | null;
    expect(overlay).not.toBeNull();
    const background = getComputedStyle(overlay!).backgroundColor;
    expect(["", "transparent", "rgba(0, 0, 0, 0)"]).toContain(background);
  });
});
