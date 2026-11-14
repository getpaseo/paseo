import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ArrowUp } from "lucide-react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { afterEach, expect, it } from "vitest";
import { PressHighlight } from "./press-highlight.native";
import { FloatingActionButton } from "./floating-action-button";

const rowStyle = { backgroundColor: "rgb(255, 255, 255)", borderRadius: 8 };
const highlightStyle = { backgroundColor: "rgb(20, 30, 40)" };

afterEach(cleanup);

function onPress() {}

it("keeps a floating action opaque while showing its held-press feedback", async () => {
  const { getByRole } = render(
    <FloatingActionButton icon={ArrowUp} accessibilityLabel="Jump to file" onPress={onPress} />,
  );
  const button = getByRole("button", { name: "Jump to file" });
  const restingFill = getComputedStyle(button).backgroundColor;

  fireEvent.mouseDown(button, { button: 0 });
  await waitFor(() => {
    const pressedFill = getComputedStyle(button).backgroundColor;
    expect(pressedFill).not.toBe(restingFill);
    expect(pressedFill).toMatch(/^rgb\(/);
  });

  fireEvent.mouseUp(button, { button: 0 });
  await waitFor(() => expect(getComputedStyle(button).backgroundColor).toBe(restingFill));
});

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
