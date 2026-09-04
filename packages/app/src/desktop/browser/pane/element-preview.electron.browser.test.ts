import { afterEach, describe, expect, it } from "vitest";
import { buildElementPreviewScript } from "./element-preview.electron";

afterEach(() => {
  window.eval("window.__paseoElementPreview?.destroy() ");
  document.body.replaceChildren();
});

describe("element preview guest script", () => {
  it("previews DOM text and styles, then restores the inspection snapshot", () => {
    document.body.innerHTML = '<h2 id="title" style="color: red">Original</h2>';
    const title = document.querySelector<HTMLElement>("#title");
    if (!title) throw new Error("Expected title");

    window.eval(
      buildElementPreviewScript({
        selector: "#title",
        changes: [
          { fieldId: "text", from: "Original", to: "Preview" },
          { fieldId: "color", path: "style.color", from: "red", to: "#3366ff" },
        ],
      }),
    );

    expect(title.textContent).toBe("Preview");
    expect(title.style.color).toBe("rgb(51, 102, 255)");

    window.eval("window.__paseoElementPreview.destroy() ");
    expect(title.textContent).toBe("Original");
    expect(title.style.color).toBe("red");
  });

  it("restores before replaying the latest change set", () => {
    document.body.innerHTML = '<input id="name" value="Original">';
    const input = document.querySelector<HTMLInputElement>("#name");
    if (!input) throw new Error("Expected input");

    window.eval(
      buildElementPreviewScript({
        selector: "#name",
        changes: [{ fieldId: "value", from: "Original", to: "First" }],
      }),
    );
    window.eval(
      buildElementPreviewScript({
        selector: "#name",
        changes: [{ fieldId: "value", from: "Original", to: "Second" }],
      }),
    );
    expect(input.value).toBe("Second");

    window.eval("window.__paseoElementPreview.destroy() ");
    expect(input.value).toBe("Original");
  });

  it("does not replace nested markup for a text change", () => {
    document.body.innerHTML = '<button id="action"><span>Original</span></button>';
    const action = document.querySelector<HTMLButtonElement>("#action");
    if (!action) throw new Error("Expected action");

    window.eval(
      buildElementPreviewScript({
        selector: "#action",
        changes: [{ fieldId: "text", from: "Original", to: "Preview" }],
      }),
    );

    expect(action.innerHTML).toBe("<span>Original</span>");
  });
});
