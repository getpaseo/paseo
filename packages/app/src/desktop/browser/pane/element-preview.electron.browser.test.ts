import { afterEach, describe, expect, it } from "vitest";
import {
  buildElementPreviewScript,
  previewElementChanges,
  restoreElementPreview,
} from "./element-preview.electron";

afterEach(() => {
  window.eval("window.__paseoElementPreview?.destroy() ");
  document.body.replaceChildren();
});

describe("element preview guest script", () => {
  it("immediately previews over important page styles and restores their original priority", () => {
    document.body.innerHTML =
      '<style>#title { color: red !important; font-size: 12px !important; }</style><h2 id="title" style="color: green !important">Original</h2>';
    const title = document.querySelector<HTMLElement>("#title");
    if (!title) throw new Error("Expected title");

    window.eval(
      buildElementPreviewScript({
        selector: "#title",
        changes: [
          { fieldId: "color", path: "style.color", from: "green", to: "blue" },
          { fieldId: "font-size", path: "style.font-size", from: "12px", to: "24px" },
        ],
      }),
    );
    expect(getComputedStyle(title).color).toBe("rgb(0, 0, 255)");
    expect(getComputedStyle(title).fontSize).toBe("24px");

    window.eval("window.__paseoElementPreview.destroy()");
    expect(getComputedStyle(title).color).toBe("rgb(0, 128, 0)");
    expect(getComputedStyle(title).fontSize).toBe("12px");
    expect(title.style.getPropertyPriority("color")).toBe("important");
    expect(title.style.getPropertyValue("font-size")).toBe("");
  });

  it("reports a missing target through the preview queue and allows cleanup", async () => {
    const webview = Object.assign(document.createElement("div"), {
      executeJavaScript: async (code: string): Promise<unknown> => window.eval(code),
    });
    document.body.append(webview);
    const previewed = await previewElementChanges(
      webview,
      {
        tag: "p",
        selector: "#removed",
        text: "Original",
        url: "https://example.test",
        outerHTML: "<p>Original</p>",
        computedStyles: {},
        boundingRect: { x: 0, y: 0, width: 100, height: 20 },
        reactSource: null,
        parentChain: [],
        children: [],
      },
      [{ fieldId: "text", from: "Original", to: "Preview" }],
    );
    expect(previewed).toBe(false);
    expect(await restoreElementPreview(webview)).toBe(true);
  });

  it("previews and restores every selected option in a multiple select", () => {
    document.body.innerHTML =
      '<select id="regions" multiple><option selected value="a">A</option><option selected value="b">B</option><option value="c">C</option></select>';
    const select = document.querySelector<HTMLSelectElement>("#regions");
    if (!select) throw new Error("Expected select");
    window.eval(
      buildElementPreviewScript({
        selector: "#regions",
        changes: [{ fieldId: "value", from: ["a", "b"], to: ["b", "c"] }],
      }),
    );
    expect(Array.from(select.selectedOptions, (option) => option.value)).toEqual(["b", "c"]);
    window.eval("window.__paseoElementPreview.destroy()");
    expect(Array.from(select.selectedOptions, (option) => option.value)).toEqual(["a", "b"]);
  });

  it("restores the original radio group selection", () => {
    document.body.innerHTML =
      '<input id="first" type="radio" name="choice" checked><input id="second" type="radio" name="choice">';
    const first = document.querySelector<HTMLInputElement>("#first");
    const second = document.querySelector<HTMLInputElement>("#second");
    if (!first || !second) throw new Error("Expected radios");
    window.eval(
      buildElementPreviewScript({
        selector: "#second",
        changes: [{ fieldId: "checked", from: false, to: true }],
      }),
    );
    expect([first.checked, second.checked]).toEqual([false, true]);
    window.eval("window.__paseoElementPreview.destroy()");
    expect([first.checked, second.checked]).toEqual([true, false]);
  });

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
