import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ArrowUp } from "lucide-react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { afterEach, expect, it } from "vitest";
import { PressHighlight } from "./press-highlight.native";
import { PressHighlight as AndroidPressHighlight } from "./press-highlight.android";
import { PressHighlight as WebPressHighlight } from "./press-highlight";
import { FloatingActionButton } from "./floating-action-button";

const rowStyle = { backgroundColor: "rgb(255, 255, 255)", borderRadius: 8 };
const highlightStyle = { backgroundColor: "rgb(20, 30, 40)" };

afterEach(cleanup);

function onPress() {}

function recordPresses() {
  const calls: string[] = [];
  return {
    calls,
    onPressIn: () => calls.push("in"),
    onPressOut: () => calls.push("out"),
  };
}

const borderedRowStyle = { ...rowStyle, borderWidth: 1, borderColor: "rgb(0, 0, 0)" };

function recordHighlights() {
  const calls: boolean[] = [];
  return { calls, record: (highlighted: boolean) => calls.push(highlighted) };
}

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

it("paints the pressed fill on web and reports it, so a caller does not paint its own", async () => {
  const highlights = recordHighlights();
  const { getByTestId } = render(
    <WebPressHighlight
      testID="row"
      style={rowStyle}
      highlightStyle={highlightStyle}
      onHighlightChange={highlights.record}
      onPress={onPress}
    />,
  );
  const row = getByTestId("row");

  fireEvent.mouseDown(row, { button: 0 });
  await waitFor(() => expect(getComputedStyle(row).backgroundColor).toBe("rgb(20, 30, 40)"));
  expect(highlights.calls).toEqual([true]);

  fireEvent.mouseUp(row, { button: 0 });
  await waitFor(() => expect(getComputedStyle(row).backgroundColor).toBe("rgb(255, 255, 255)"));
  expect(highlights.calls).toEqual([true, false]);
});

it("leaves the Android row surface alone while pressed and clips the ripple to its corners", () => {
  const highlights = recordHighlights();
  const { getByTestId } = render(
    <AndroidPressHighlight
      testID="row"
      testOnly_pressed
      style={rowStyle}
      highlightStyle={highlightStyle}
      onHighlightChange={highlights.record}
    />,
  );
  const row = getComputedStyle(getByTestId("row"));

  expect(row.backgroundColor).toBe("rgb(255, 255, 255)");
  expect(row.borderRadius).toBe("8px");
  expect(row.overflow).toBe("hidden");
  expect(highlights.calls).toEqual([]);
});

it("keeps the caller's border and press handlers on the Android ripple row", async () => {
  const presses = recordPresses();
  const { getByTestId } = render(
    <AndroidPressHighlight
      testID="row"
      style={borderedRowStyle}
      highlightStyle={highlightStyle}
      onPressIn={presses.onPressIn}
      onPressOut={presses.onPressOut}
      onPress={onPress}
    />,
  );
  const row = getByTestId("row");

  expect(getComputedStyle(row).borderTopWidth).toBe("1px");
  fireEvent.mouseDown(row, { button: 0 });
  fireEvent.mouseUp(row, { button: 0 });
  await waitFor(() => expect(presses.calls).toEqual(["in", "out"]));
});

it("paints and reports nothing on web without a pressed fill, such as a row being renamed", () => {
  const highlights = recordHighlights();
  const { getByTestId } = render(
    <WebPressHighlight
      testID="row"
      style={rowStyle}
      onHighlightChange={highlights.record}
      onPress={onPress}
    />,
  );
  const row = getByTestId("row");

  fireEvent.mouseDown(row, { button: 0 });
  expect(getComputedStyle(row).backgroundColor).toBe("rgb(255, 255, 255)");
  fireEvent.mouseUp(row, { button: 0 });
  expect(highlights.calls).toEqual([]);
});
