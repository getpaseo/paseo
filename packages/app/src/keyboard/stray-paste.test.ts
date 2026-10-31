import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KeyboardFocusScope } from "./actions";
import { resolveStrayPasteText } from "./stray-paste";

class FakeElement {
  tagName: string;
  private attributes: Record<string, string>;

  constructor(tagName: string, attributes: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
  }

  closest(selector: string): FakeElement | null {
    const tag = this.tagName.toLowerCase();
    const matches = selector.split(",").some((part) => {
      const trimmed = part.trim();
      if (trimmed === "[contenteditable]") return "contenteditable" in this.attributes;
      return trimmed === tag;
    });
    return matches ? this : null;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
}

function clipboard(text: string, fileCount = 0): DataTransfer {
  return {
    files: { length: fileCount },
    getData: (type: string) => (type === "text/plain" ? text : ""),
  } as unknown as DataTransfer;
}

function resolve(
  target: FakeElement | null,
  data: DataTransfer | null,
  focusScope: KeyboardFocusScope = "other",
) {
  return resolveStrayPasteText({
    target: target as unknown as EventTarget,
    focusScope,
    clipboardData: data,
  });
}

describe("resolveStrayPasteText", () => {
  const globalRef = globalThis as { Element?: unknown };
  const originalElement = globalRef.Element;

  beforeEach(() => {
    globalRef.Element = FakeElement;
  });

  afterEach(() => {
    globalRef.Element = originalElement;
  });

  it("takes text pasted onto a non-editable element or nothing", () => {
    expect(resolve(new FakeElement("div"), clipboard("hello"))).toBe("hello");
    expect(resolve(null, clipboard("hello"))).toBe("hello");
  });

  it("takes text pasted while a composer toolbar button has focus", () => {
    expect(resolve(new FakeElement("button"), clipboard("hi"), "message-input")).toBe("hi");
  });

  it("leaves text fields to their own paste handling", () => {
    expect(resolve(new FakeElement("input"), clipboard("hi"))).toBeNull();
    expect(resolve(new FakeElement("input", { type: "search" }), clipboard("hi"))).toBeNull();
    expect(resolve(new FakeElement("textarea"), clipboard("hi"))).toBeNull();
    expect(
      resolve(new FakeElement("div", { contenteditable: "true" }), clipboard("hi")),
    ).toBeNull();
  });

  it("ignores terminal, editable and command center scopes", () => {
    for (const scope of ["terminal", "editable", "command-center"] as const) {
      expect(resolve(new FakeElement("div"), clipboard("hi"), scope)).toBeNull();
    }
  });

  it("ignores empty clipboards and clipboards carrying files", () => {
    expect(resolve(new FakeElement("div"), clipboard(""))).toBeNull();
    expect(resolve(new FakeElement("div"), clipboard("caption", 1))).toBeNull();
    expect(resolve(new FakeElement("div"), null)).toBeNull();
  });

  it("normalizes Windows line endings like a textarea paste", () => {
    expect(resolve(new FakeElement("div"), clipboard("one\r\ntwo\rthree"))).toBe("one\ntwo\nthree");
  });
});
