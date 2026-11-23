import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Platform } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native-gesture-handler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-native-gesture-handler")>()),
  GestureDetector: ({ children }: { children: ReactElement }) => (
    <span data-detector="true">{children}</span>
  ),
}));

const { IndependentScrollBoundary, useIndependentScrollGesture } =
  await import("./independent-scroll-boundary");

function ClaimedProbe() {
  const gesture = useIndependentScrollGesture();
  const flags = gesture
    ? `${gesture.config.shouldActivateOnStart},${gesture.config.disallowInterruption},${gesture.config.shouldCancelWhenOutside}`
    : "none";
  return <span data-flags={flags} />;
}

function renderBoundary() {
  return renderToStaticMarkup(
    <IndependentScrollBoundary>
      <ClaimedProbe />
    </IndependentScrollBoundary>,
  );
}

afterEach(() => {
  Platform.OS = "web";
});

describe("IndependentScrollBoundary", () => {
  it("claims the touch stream of a nested scroller on Android", () => {
    Platform.OS = "android";

    const markup = renderBoundary();

    expect(markup).toContain('data-detector="true"');
    expect(markup).toContain('data-flags="true,true,false"');
  });

  it.each(["ios", "web"] as const)("renders the child untouched on %s", (platform) => {
    Platform.OS = platform;

    const markup = renderBoundary();

    expect(markup).not.toContain("data-detector");
    expect(markup).toContain('data-flags="none"');
  });
});
