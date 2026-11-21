import { describe, expect, it } from "vitest";
import { findSvgIconProblem } from "./icons.js";

describe("findSvgIconProblem", () => {
  it.each([
    ["a plain SVG", '<svg viewBox="0 0 24 24"><path d="M0 0h24v24z" /></svg>'],
    ["leading whitespace", '\n  <svg viewBox="0 0 24 24"></svg>'],
    [
      "a fragment reference",
      '<svg><defs><path id="mark" d="M0 0h1v1z" /></defs><use href="#mark" /></svg>',
    ],
    ["currentColor fills", '<svg fill="currentColor"><circle r="4" /></svg>'],
  ])("accepts %s", (_name, svg) => {
    expect(findSvgIconProblem(svg)).toBeNull();
  });

  it.each([
    ["a non-SVG document", "hello", "not an SVG document"],
    ["an <svgx> element", "<svgx></svgx>", "not an SVG document"],
    ["a script", "<svg><script /></svg>", "script elements are not allowed"],
    ["a foreign object", "<svg><foreignObject /></svg>", "foreignObject elements are not allowed"],
    ["a style", "<svg><style /></svg>", "style elements are not allowed"],
    [
      "an event handler",
      '<svg><path onclick="run()" /></svg>',
      "event-handler attributes are not allowed",
    ],
    [
      "a javascript URL",
      '<svg><a href="javascript:run()" /></svg>',
      "javascript URLs are not allowed",
    ],
    [
      "an external href",
      '<svg><use href="https://example.com/icon.svg" /></svg>',
      "external href references are not allowed",
    ],
    [
      "an external xlink:href",
      "<svg><image xlink:href=icon.png /></svg>",
      "external href references are not allowed",
    ],
    ["markup over 64 KiB", `<svg>${" ".repeat(64 * 1024)}</svg>`, "exceeds 64 KiB"],
  ])("rejects %s", (_name, svg, reason) => {
    expect(findSvgIconProblem(svg)).toBe(reason);
  });

  it("measures the size in UTF-8 bytes", () => {
    const multibyte = "é".repeat(32 * 1024);

    expect(findSvgIconProblem(`<svg>${multibyte}</svg>`)).toBe("exceeds 64 KiB");
  });
});
