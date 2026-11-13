import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMessageInputTargetEmpty, resolveKeyboardFocusScope } from "./focus-scope";

class FakeNode {
  parentElement: FakeElement | null = null;
}

class FakeElement extends FakeNode {
  tagName: string;
  isContentEditable = false;
  value?: string;
  textContent: string | null = null;
  private selectors: Set<string>;

  constructor(input?: {
    tagName?: string;
    selectors?: string[];
    isContentEditable?: boolean;
    value?: string;
    textContent?: string | null;
  }) {
    super();
    this.tagName = (input?.tagName ?? "div").toUpperCase();
    this.selectors = new Set(input?.selectors ?? []);
    if (input?.isContentEditable) {
      this.isContentEditable = true;
    }
    if (input?.value !== undefined) {
      this.value = input.value;
    }
    if (input?.textContent !== undefined) {
      this.textContent = input.textContent;
    }
  }

  closest(selector: string): FakeElement | null {
    if (this.selectors.has(selector)) {
      return this;
    }
    return this.parentElement?.closest(selector) ?? null;
  }
}

describe("resolveKeyboardFocusScope", () => {
  const globalRef = globalThis as {
    Element?: unknown;
    Node?: unknown;
    document?: { activeElement?: unknown };
  };
  const originalElement = globalRef.Element;
  const originalNode = globalRef.Node;
  const originalDocument = globalRef.document;

  beforeEach(() => {
    globalRef.Element = FakeElement;
    globalRef.Node = FakeNode;
    globalRef.document = { activeElement: null };
  });

  afterEach(() => {
    globalRef.Element = originalElement;
    globalRef.Node = originalNode;
    globalRef.document = originalDocument;
  });

  it("resolves terminal scope from the direct keyboard event target", () => {
    const target = new FakeElement({ selectors: [".xterm"] });
    const scope = resolveKeyboardFocusScope({
      target: target as unknown as EventTarget,
      commandCenterOpen: false,
    });
    expect(scope).toBe("terminal");
  });

  it("falls back to activeElement when target is not an Element", () => {
    const activeElement = new FakeElement({ selectors: [".xterm"] });
    globalRef.document = { activeElement };
    const scope = resolveKeyboardFocusScope({
      target: null,
      commandCenterOpen: false,
    });
    expect(scope).toBe("terminal");
  });

  it("detects editable scope from activeElement fallback", () => {
    const activeElement = new FakeElement({ tagName: "input" });
    globalRef.document = { activeElement };
    const scope = resolveKeyboardFocusScope({
      target: null,
      commandCenterOpen: false,
    });
    expect(scope).toBe("editable");
  });

  it("reports whether a focused message-input text control is empty", () => {
    const root = new FakeElement({ selectors: ["[data-testid='message-input-root']"] });
    const emptyTextarea = new FakeElement({ tagName: "textarea", value: "" });
    emptyTextarea.parentElement = root;
    expect(isMessageInputTargetEmpty(emptyTextarea as unknown as EventTarget)).toBe(true);

    const draftTextarea = new FakeElement({ tagName: "textarea", value: " " });
    draftTextarea.parentElement = root;
    expect(isMessageInputTargetEmpty(draftTextarea as unknown as EventTarget)).toBe(false);

    const emptyEditable = new FakeElement({ isContentEditable: true, textContent: "" });
    emptyEditable.parentElement = root;
    expect(isMessageInputTargetEmpty(emptyEditable as unknown as EventTarget)).toBe(true);

    const nonComposerInput = new FakeElement({ tagName: "textarea", value: "" });
    expect(isMessageInputTargetEmpty(nonComposerInput as unknown as EventTarget)).toBe(false);
  });
});
