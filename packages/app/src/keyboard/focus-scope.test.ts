import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveKeyboardFocusScope } from "./focus-scope";

class FakeNode {
  parentElement: FakeElement | null = null;
}

class FakeElement extends FakeNode {
  tagName: string;
  isContentEditable = false;
  private selectors: Set<string>;

  private readonly attributes: Map<string, string>;

  constructor(input?: {
    tagName?: string;
    selectors?: string[];
    isContentEditable?: boolean;
    role?: string;
  }) {
    super();
    this.tagName = (input?.tagName ?? "div").toUpperCase();
    this.selectors = new Set(input?.selectors ?? []);
    this.attributes = new Map(input?.role ? [["role", input.role]] : []);
    if (input?.isContentEditable) {
      this.isContentEditable = true;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
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

  describe("activatable controls", () => {
    it.each(["switch", "checkbox", "radio", "button"])(
      "resolves role %s to the control scope so global keys do not swallow activation",
      (role) => {
        const scope = resolveKeyboardFocusScope({
          target: new FakeElement({ role }) as unknown as EventTarget,
          commandCenterOpen: false,
        });
        expect(scope).toBe("control");
      },
    );

    it("resolves a native button element to the control scope", () => {
      const scope = resolveKeyboardFocusScope({
        target: new FakeElement({ tagName: "button" }) as unknown as EventTarget,
        commandCenterOpen: false,
      });
      expect(scope).toBe("control");
    });

    it("keeps a plain element in the other scope", () => {
      const scope = resolveKeyboardFocusScope({
        target: new FakeElement({}) as unknown as EventTarget,
        commandCenterOpen: false,
      });
      expect(scope).toBe("other");
    });

    it("keeps a native input in the editable scope", () => {
      const scope = resolveKeyboardFocusScope({
        target: new FakeElement({ tagName: "input", role: "switch" }) as unknown as EventTarget,
        commandCenterOpen: false,
      });
      expect(scope).toBe("editable");
    });

    it("still yields to an open command center", () => {
      const scope = resolveKeyboardFocusScope({
        target: new FakeElement({ role: "switch" }) as unknown as EventTarget,
        commandCenterOpen: true,
      });
      expect(scope).toBe("command-center");
    });
  });
});
