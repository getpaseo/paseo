import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRootUiFont } from "./apply-root-font.web";

describe("applyRootUiFont", () => {
  const originalDocument = globalThis.document;

  afterEach(() => {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", {
        value: originalDocument,
        configurable: true,
        writable: true,
      });
    }
  });

  it("excludes data-pmono and role=math subtrees from the UI font override", () => {
    const appended: Array<{ id?: string; textContent?: string | null }> = [];
    const setProperty = vi.fn();

    Object.defineProperty(globalThis, "document", {
      value: {
        documentElement: { style: { setProperty } },
        getElementById: () => null,
        createElement: () => ({ id: "", textContent: "" }),
        head: {
          appendChild: (node: { id?: string; textContent?: string | null }) => {
            appended.push(node);
            return node;
          },
        },
      },
      configurable: true,
      writable: true,
    });

    applyRootUiFont("Inter, sans-serif");

    expect(setProperty).toHaveBeenCalledWith("--paseo-ui-font", "Inter, sans-serif");
    expect(appended).toHaveLength(1);
    expect(appended[0]?.id).toBe("paseo-ui-font");
    expect(appended[0]?.textContent).toContain(":not([data-pmono]):not([data-pmono] *)");
    expect(appended[0]?.textContent).toContain(':not([role="math"]):not([role="math"] *)');
  });
});
