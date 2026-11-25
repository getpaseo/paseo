/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { Text } from "react-native";
import Animated, { makeMutable } from "react-native-reanimated";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface KeyboardState {
  status: string;
  heightWithinContainer: number;
}

const sheetState = vi.hoisted(() => ({
  detents: null as ReturnType<typeof makeMutable<{ detents: number[] }>> | null,
  keyboard: null as ReturnType<typeof makeMutable<KeyboardState>> | null,
  layout: null as ReturnType<
    typeof makeMutable<{ containerHeight: number; handleHeight: number }>
  > | null,
  position: null as ReturnType<typeof makeMutable<number>> | null,
}));

vi.mock("@gorhom/bottom-sheet", () => ({
  KEYBOARD_STATUS: {
    UNDETERMINED: "UNDETERMINED",
    SHOWN: "SHOWN",
    HIDDEN: "HIDDEN",
  },
  useBottomSheetInternal: () => ({
    animatedDetentsState: sheetState.detents,
    animatedKeyboardState: sheetState.keyboard,
    animatedLayoutState: sheetState.layout,
    animatedPosition: sheetState.position,
  }),
}));

import { SheetVisibleFrame, useBottomSheetSafeAreaPaddingStyle } from "./visible-frame";

const INSETS = { top: 44, right: 0, bottom: 96, left: 0 };

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.stubGlobal("React", React);
  sheetState.detents = makeMutable({ detents: [161] });
  sheetState.keyboard = makeMutable<KeyboardState>({
    status: "UNDETERMINED",
    heightWithinContainer: 0,
  });
  sheetState.layout = makeMutable({ containerHeight: 1608, handleHeight: 48 });
  sheetState.position = makeMutable(161);
});

function renderFrame(props: {
  footer?: React.ReactNode;
  safeAreaInset?: "footer" | "frame" | "none";
  children?: React.ReactNode;
}) {
  return render(
    <SafeAreaInsetsContext.Provider value={INSETS}>
      <SheetVisibleFrame
        footer={props.footer}
        safeAreaInset={props.safeAreaInset}
        testID="sheet-visible-frame"
      >
        {props.children ?? <Text>Body</Text>}
      </SheetVisibleFrame>
    </SafeAreaInsetsContext.Provider>,
  );
}

function ScrollBodyProbe({ enabled }: { enabled: boolean }) {
  const paddingStyle = useBottomSheetSafeAreaPaddingStyle(enabled);
  return (
    <Animated.View style={paddingStyle} testID="sheet-scroll-body">
      <Text>Scroll content</Text>
    </Animated.View>
  );
}

async function setKeyboardState(next: KeyboardState) {
  await act(async () => {
    sheetState.keyboard?.set(next);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

describe("SheetVisibleFrame safe-area keyboard lockstep", () => {
  it("updates height and safe-area paddingBottom together on the frame across keyboard show/hide", async () => {
    const footer = <Text>Open project</Text>;

    // Resting closed: full height + bottom safe-area clearance.
    renderFrame({ footer });
    const frame = screen.getByTestId("sheet-visible-frame");
    expect(frame.style.height).toBe("1399px");
    expect(frame.style.paddingBottom).toBe("96px");

    // First-open intermediate state before heightWithinContainer is written: no flash to 0.
    await setKeyboardState({ status: "SHOWN", heightWithinContainer: 0 });
    expect(frame.style.height).toBe("1399px");
    expect(frame.style.paddingBottom).toBe("96px");

    // Keyboard shown: height shrinks by keyboard and safe-area padding drops to 0 in lockstep.
    await setKeyboardState({ status: "SHOWN", heightWithinContainer: 598 });
    expect(frame.style.height).toBe("801px");
    expect(frame.style.paddingBottom).toBe("0px");

    // Keyboard hidden (with Gorhom's retained heightWithinContainer): height restores and
    // safe-area padding restores in the same frame — never flashing to 0 behind the nav bar.
    await setKeyboardState({ status: "HIDDEN", heightWithinContainer: 598 });
    expect(frame.style.height).toBe("1399px");
    expect(frame.style.paddingBottom).toBe("96px");
  });

  it("leaves frame paddingBottom at 0 when no footer is rendered under default safeAreaInset='footer' and syncs scrollable body clearance", async () => {
    renderFrame({ footer: null, children: <ScrollBodyProbe enabled /> });
    const frame = screen.getByTestId("sheet-visible-frame");
    const scrollBody = screen.getByTestId("sheet-scroll-body");
    expect(frame.style.height).toBe("1399px");
    expect(frame.style.paddingBottom).toBe("0px");
    expect(scrollBody.style.paddingBottom).toBe("96px");

    await setKeyboardState({ status: "SHOWN", heightWithinContainer: 598 });
    expect(frame.style.height).toBe("801px");
    expect(scrollBody.style.paddingBottom).toBe("0px");

    await setKeyboardState({ status: "HIDDEN", heightWithinContainer: 598 });
    expect(frame.style.height).toBe("1399px");
    expect(scrollBody.style.paddingBottom).toBe("96px");
  });

  it("pads the frame without a footer when safeAreaInset='frame' and drops it while keyboard is shown", async () => {
    renderFrame({ footer: null, safeAreaInset: "frame" });
    const frame = screen.getByTestId("sheet-visible-frame");
    expect(frame.style.height).toBe("1399px");
    expect(frame.style.paddingBottom).toBe("96px");

    await setKeyboardState({ status: "SHOWN", heightWithinContainer: 598 });
    expect(frame.style.height).toBe("801px");
    expect(frame.style.paddingBottom).toBe("0px");

    await setKeyboardState({ status: "HIDDEN", heightWithinContainer: 598 });
    expect(frame.style.height).toBe("1399px");
    expect(frame.style.paddingBottom).toBe("96px");
  });
});
