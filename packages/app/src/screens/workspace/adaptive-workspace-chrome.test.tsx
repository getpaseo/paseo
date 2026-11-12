/** @vitest-environment jsdom */
import React, { Profiler } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  onLayout: (_event: { nativeEvent: { layout: { width: number } } }) => {},
}));

vi.mock("react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-native")>()),
  View: ({
    onLayout,
    children,
  }: {
    onLayout: typeof fixture.onLayout;
    children: React.ReactNode;
  }) => {
    fixture.onLayout = onLayout;
    return <div>{children}</div>;
  },
}));
vi.mock("./workspace-desktop-tabs-row", () => ({
  WorkspaceTabMeasurementScope: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { AdaptiveWorkspaceChrome } from "./adaptive-workspace-chrome";

let commits = 0;
const onRender = () => {
  commits += 1;
};
const compactHeader = <span>compact</span>;
afterEach(cleanup);

describe("AdaptiveWorkspaceChrome", () => {
  it("re-renders only when measured widths cross the compact threshold", () => {
    commits = 0;
    render(
      <Profiler id="chrome" onRender={onRender}>
        <AdaptiveWorkspaceChrome compactHeader={compactHeader}>
          <span>full</span>
        </AdaptiveWorkspaceChrome>
      </Profiler>,
    );
    const measure = (width: number) =>
      act(() => fixture.onLayout({ nativeEvent: { layout: { width } } }));
    expect(screen.getByText("full")).toBeTruthy();
    const initial = commits;
    measure(10000);
    measure(9000);
    expect(commits).toBe(initial);
    measure(1);
    expect(screen.getByText("compact")).toBeTruthy();
    expect(commits).toBe(initial + 1);
    measure(0);
    expect(screen.getByText("compact")).toBeTruthy();
    measure(10000);
    expect(screen.getByText("full")).toBeTruthy();
    expect(commits).toBe(initial + 2);
  });

  it("keeps the full header when no compact header is available", () => {
    render(
      <AdaptiveWorkspaceChrome compactHeader={null}>
        <span>full</span>
      </AdaptiveWorkspaceChrome>,
    );
    act(() => fixture.onLayout({ nativeEvent: { layout: { width: 1 } } }));
    expect(screen.getByText("full")).toBeTruthy();
  });
});
