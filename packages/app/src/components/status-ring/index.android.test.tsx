import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const { theme, useStatusRingRotation } = vi.hoisted(() => ({
  theme: { colors: { statusDotRunning: "#0088ff" } },
  useStatusRingRotation: vi.fn(() => {
    throw new Error("Android running indicators must not start a ShadowTree animation clock");
  }),
}));

vi.mock("./clock", () => ({ useStatusRingRotation }));

vi.mock("react-native", () => ({
  ActivityIndicator: (props: { color: string; size: number }) =>
    React.createElement("span", {
      "data-platform-spinner": true,
      "data-color": props.color,
      "data-size": props.size,
    }),
}));

vi.mock("react-native-unistyles", () => ({
  withUnistyles:
    (
      Component: React.ComponentType<Record<string, unknown>>,
      mappings: (value: typeof theme) => Record<string, unknown>,
    ) =>
    (props: Record<string, unknown>) =>
      React.createElement(Component, { ...mappings(theme), ...props }),
}));

vi.mock("./frame", () => ({
  StatusRingFrame: (props: { backdrop: string; children: React.ReactNode }) =>
    React.createElement("div", { "data-backdrop": props.backdrop }, props.children),
  rotatorStyles: { rotator: { position: "absolute", width: 12, height: 12 } },
}));

vi.stubGlobal("React", React);

import { StatusRing } from "./index.android";

beforeEach(() => {
  theme.colors.statusDotRunning = "#0088ff";
  useStatusRingRotation.mockClear();
});

it("keeps a framed running indicator without starting the shared animation clock", () => {
  const markup = renderToStaticMarkup(<StatusRing backdrop="surfaceSidebar" />);
  expect(markup).toContain('data-platform-spinner="true"');
  expect(markup).toContain('data-size="12"');
  expect(markup).toContain('data-backdrop="surfaceSidebar"');
  expect(useStatusRingRotation).not.toHaveBeenCalled();
});

it("maps the running status color through the theme wrapper", () => {
  expect(renderToStaticMarkup(<StatusRing />)).toContain('data-color="#0088ff"');
  theme.colors.statusDotRunning = "#55aaff";
  expect(renderToStaticMarkup(<StatusRing />)).toContain('data-color="#55aaff"');
});
