import { describe, expect, it } from "vitest";
import { createKeyboardFocusScope } from "./internal/focus-surfaces";

describe("declared keyboard focus", () => {
  it("recognizes ordinary native editors while preserving declared scopes", () => {
    let focused = false;
    const scope = createKeyboardFocusScope(() => focused);
    expect(scope.resolve(false)).toBe("other");
    focused = true;
    expect(scope.resolve(false)).toBe("editable");
    const release = scope.declare("message-input");
    expect(scope.resolve(false)).toBe("message-input");
    expect(scope.resolve(true)).toBe("command-center");
    release();
    expect(scope.resolve(false)).toBe("editable");
    focused = false;
    expect(scope.resolve(false)).toBe("other");
  });
  it("tracks composer and terminal focus without stale cleanup losing the new owner", () => {
    const scope = createKeyboardFocusScope();
    expect(scope.resolve(false)).toBe("other");
    const releaseTerminal = scope.declare("terminal");
    expect(scope.resolve(false)).toBe("terminal");
    const releaseComposer = scope.declare("message-input");
    releaseTerminal();
    expect(scope.resolve(false)).toBe("message-input");
    expect(scope.resolve(true)).toBe("command-center");
    releaseComposer();
    releaseComposer();
    expect(scope.resolve(false)).toBe("other");
  });
});
