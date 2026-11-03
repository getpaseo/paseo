/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { Text } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SheetBottomInset } from "./adaptive-modal-sheet";

beforeEach(() => vi.stubGlobal("React", React));

const SCREEN_INSETS = { top: 24, right: 0, bottom: 34, left: 0 };

function BottomInsetProbe() {
  return <Text testID="content-bottom-inset">{String(useSafeAreaInsets().bottom)}</Text>;
}

describe("SheetBottomInset", () => {
  it("pads the bottom inset once and leaves none for its content", () => {
    render(
      <SafeAreaInsetsContext.Provider value={SCREEN_INSETS}>
        <SheetBottomInset testID="sheet-body">
          <BottomInsetProbe />
        </SheetBottomInset>
      </SafeAreaInsetsContext.Provider>,
    );

    expect(screen.getByTestId("sheet-body").style.paddingBottom).toBe("34px");
    // Content that pads the inset itself, like the composer dock, must not pad it again.
    expect(screen.getByTestId("content-bottom-inset").textContent).toBe("0");
  });
});
