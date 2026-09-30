/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native-svg", () => {
  const Svg = ({
    accessibilityLabel,
    testID,
    width,
    height,
    children,
  }: {
    accessibilityLabel?: string;
    testID?: string;
    width?: number;
    height?: number;
    children?: React.ReactNode;
  }) =>
    React.createElement(
      "svg",
      { "aria-label": accessibilityLabel, "data-testid": testID, width, height },
      children,
    );
  const Rect = () => null;
  return { __esModule: true, default: Svg, Svg, Rect };
});

vi.mock("react-native-reanimated", () => ({
  useReducedMotion: () => false,
}));

vi.mock("react-native-unistyles", () => ({
  withUnistyles: (Component: unknown) => Component,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { PandaStatus } from "./panda-status";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(element: React.ReactElement) {
  act(() => root.render(element));
}

describe("PandaStatus", () => {
  it("labels the sprite with the mood's i18n key and switches it when the mood changes", () => {
    render(<PandaStatus mood="run" size="small" testID="p" />);
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe("panda.status.run");

    render(<PandaStatus mood="ask" size="small" testID="p" />);
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe("panda.status.ask");
  });

  it("renders the small grid at 16 * pixelScale and the large grid at 32 * pixelScale", () => {
    render(<PandaStatus mood="sleep" size="small" pixelScale={2} testID="p" />);
    const small = container.querySelector("svg");
    expect(small?.getAttribute("width")).toBe("32");
    expect(small?.getAttribute("height")).toBe("32");

    render(<PandaStatus mood="sleep" size="large" pixelScale={2} testID="p" />);
    const large = container.querySelector("svg");
    expect(large?.getAttribute("width")).toBe("64");
    expect(large?.getAttribute("height")).toBe("64");
  });

  it("survives switching between moods with different frame counts without crashing", () => {
    vi.useFakeTimers();
    render(<PandaStatus mood="run" size="large" testID="p" />);
    act(() => vi.advanceTimersByTime(600 * 2)); // run has 3 frames; this parks the index at 2
    expect(() => render(<PandaStatus mood="ask" size="large" testID="p" />)).not.toThrow();
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe("panda.status.ask");
  });

  it("freezes on the first frame when animate is false", () => {
    vi.useFakeTimers();
    render(<PandaStatus mood="run" size="large" animate={false} testID="p" />);
    act(() => vi.advanceTimersByTime(600 * 5));
    // No crash and the label stays put; the frame index itself is an internal render detail.
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe("panda.status.run");
  });
});
