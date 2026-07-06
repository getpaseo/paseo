/**
 * @vitest-environment jsdom
 */
import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/device-timezone", () => ({
  getDeviceTimeZone: () => "America/Los_Angeles",
}));

vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
  Pressable: ({
    children,
    onPress,
    testID,
  }: {
    children?:
      | React.ReactNode
      | ((state: { pressed: boolean; hovered: boolean }) => React.ReactNode);
    onPress?: () => void;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      { "data-testid": testID, onClick: onPress, type: "button" },
      typeof children === "function" ? children({ pressed: false, hovered: false }) : children,
    ),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (styles: unknown) => styles,
  },
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveTextInput: ({
    onChangeText,
    testID,
    value,
  }: {
    onChangeText: (text: string) => void;
    testID?: string;
    value?: string;
  }) =>
    React.createElement("input", {
      "data-testid": testID,
      value,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.target.value),
    }),
}));

vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: ({
    onValueChange,
    options,
    testID,
    value,
  }: {
    onValueChange: (value: string) => void;
    options: { value: string; label: string }[];
    testID?: string;
    value: string;
  }) =>
    React.createElement(
      "div",
      { "data-testid": testID },
      options.map((option) =>
        React.createElement(
          "button",
          {
            key: option.value,
            "aria-pressed": option.value === value,
            onClick: () => onValueChange(option.value),
            type: "button",
          },
          option.label,
        ),
      ),
    ),
}));

const EXISTING_NEW_YORK_CRON = {
  type: "cron" as const,
  expression: "0 9 * * *",
  timezone: "America/New_York",
};

describe("CadenceEditor", () => {
  it("preserves an existing cron cadence timezone when editing the expression", async () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const { CadenceEditor } = await import("./cadence-editor");
    const onChange = vi.fn();
    const { getByTestId } = render(
      <CadenceEditor value={EXISTING_NEW_YORK_CRON} onChange={onChange} />,
    );

    fireEvent.change(getByTestId("cadence-cron-expression"), {
      target: { value: "30 9 * * *" },
    });

    expect(onChange).toHaveBeenCalledWith({
      type: "cron",
      expression: "30 9 * * *",
      timezone: "America/New_York",
    });
  });
});
