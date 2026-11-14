import React from "react";
import { cleanup, render } from "@testing-library/react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { afterEach, expect, it } from "vitest";
import { PressHighlight } from "./press-highlight.native";

const rowStyle = { backgroundColor: "rgb(255, 255, 255)", borderRadius: 8 };
const highlightStyle = { backgroundColor: "rgb(20, 30, 40)" };

afterEach(cleanup);

it("uses the pressable's pressed state for the native row fill and its existing corners", () => {
  const { getByTestId, rerender } = render(
    <GestureHandlerRootView>
      <PressHighlight
        testID="row"
        testOnly_pressed
        style={rowStyle}
        highlightStyle={highlightStyle}
      />
    </GestureHandlerRootView>,
  );

  expect(getComputedStyle(getByTestId("row")).backgroundColor).toBe("rgb(20, 30, 40)");
  expect(getComputedStyle(getByTestId("row")).borderRadius).toBe("8px");

  rerender(
    <GestureHandlerRootView>
      <PressHighlight
        testID="row"
        testOnly_pressed={false}
        style={rowStyle}
        highlightStyle={highlightStyle}
      />
    </GestureHandlerRootView>,
  );
  expect(getComputedStyle(getByTestId("row")).backgroundColor).toBe("rgb(255, 255, 255)");
});
