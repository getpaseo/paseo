import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownsListNavigationKeys, resolveKeyboardFocusScope } from "./focus-scope";

class FakeNode {
  parentElement: FakeElement | null = null;
}

class FakeElement extends FakeNode {
  tagName: string;
  isContentEditable = false;
  private selectors: Set<string>;

  constructor(input?: { tagName?: string; selectors?: string[]; isContentEditable?: boolean }) {
    super();
    this.tagName = (input?.tagName ?? "div").toUpperCase();
    this.selectors = new Set(input?.selectors ?? []);
    if (input?.isContentEditable) {
      this.isContentEditable = true;
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

  it("keeps the composer's scope while an open menu owns the list-navigation keys", () => {
    const menu = new FakeElement({ selectors: ["[data-keyboard-scope='list-search']"] });
    const composer = new FakeElement({ selectors: ["[data-testid='message-input-root']"] });
    menu.parentElement = composer;
    const target = new FakeElement({ tagName: "textarea" });
    target.parentElement = menu;

    expect(ownsListNavigationKeys(target as unknown as EventTarget)).toBe(true);
    expect(
      resolveKeyboardFocusScope({
        target: target as unknown as EventTarget,
        commandCenterOpen: false,
      }),
    ).toBe("message-input");
  });

  it("reports no list-navigation ownership for an ordinary field", () => {
    const target = new FakeElement({ tagName: "input" });
    expect(ownsListNavigationKeys(target as unknown as EventTarget)).toBe(false);
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
});
