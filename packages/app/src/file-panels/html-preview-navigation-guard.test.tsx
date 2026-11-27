// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { useHtmlPreviewNavigationGuard } from "./html-preview-navigation";

const DOCUMENT = "<html><body>report</body></html>";

function renderGuard(initialActive: boolean) {
  let active = initialActive;
  const view = renderHook(() => useHtmlPreviewNavigationGuard(DOCUMENT), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <RetainedPanelActivity active={active}>{children}</RetainedPanelActivity>
    ),
  });
  return {
    navigate: (url: string) => view.result.current({ url }),
    setActive(next: boolean) {
      active = next;
      view.rerender();
    },
  };
}

describe("useHtmlPreviewNavigationGuard", () => {
  it("loads the document once and refuses the page loading it again", () => {
    const guard = renderGuard(true);

    expect(guard.navigate("about:blank")).toBe(true);
    expect(guard.navigate("about:blank")).toBe(false);
    expect(guard.navigate("https://example.com/leak")).toBe(false);
    expect(guard.navigate("about:blank#section")).toBe(true);
  });

  it("loads the document again in the WebView that shows after the panel was hidden", () => {
    const guard = renderGuard(true);
    expect(guard.navigate("about:blank")).toBe(true);

    // iOS destroys the native WebView of a hidden panel and makes a new one when it shows.
    guard.setActive(false);
    guard.setActive(true);

    expect(guard.navigate("about:blank")).toBe(true);
    expect(guard.navigate("about:blank")).toBe(false);
  });
});
