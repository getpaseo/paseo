// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FileHtmlPreview } from "./html-preview.web";

describe("FileHtmlPreview on web", () => {
  it("loads a changed document in a new frame", () => {
    const view = render(<FileHtmlPreview html="<h1>First plan</h1>" testID="preview" />);
    const firstFrame = view.getByTestId("preview");

    view.rerender(<FileHtmlPreview html="<h1>Changed plan</h1>" testID="preview" />);
    const changedFrame = view.getByTestId("preview");

    expect(changedFrame).not.toBe(firstFrame);
    expect(decodeURIComponent(changedFrame.getAttribute("src") ?? "")).toContain("Changed plan");
  });
});
