import { describe, expect, it, vi } from "vitest";
import {
  applyComposerTabKeyDownResult,
  insertComposerTabIndent,
  isPlainTabKey,
  resolveComposerTabKeyDown,
  type ResolveComposerTabKeyDownInput,
} from "./tab-indent";

function plainTabEvent(overrides: Partial<ResolveComposerTabKeyDownInput["event"]> = {}) {
  return {
    key: "Tab",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...overrides,
  };
}

function baseResolve(
  overrides: Partial<ResolveComposerTabKeyDownInput> = {},
): ResolveComposerTabKeyDownInput {
  return {
    event: plainTabEvent(),
    value: "hello",
    selectionStart: 5,
    selectionEnd: 5,
    disabled: false,
    isDictating: false,
    isRealtimeVoiceForCurrentAgent: false,
    ...overrides,
  };
}

describe("insertComposerTabIndent", () => {
  it("inserts a tab at an empty selection in the middle and moves the cursor after it", () => {
    expect(
      insertComposerTabIndent({
        value: "foo\nbar",
        selectionStart: 4,
        selectionEnd: 4,
      }),
    ).toEqual({
      value: "foo\n\tbar",
      selectionStart: 5,
      selectionEnd: 5,
    });
  });

  it("inserts a tab at the start of the value", () => {
    expect(
      insertComposerTabIndent({
        value: "code",
        selectionStart: 0,
        selectionEnd: 0,
      }),
    ).toEqual({
      value: "\tcode",
      selectionStart: 1,
      selectionEnd: 1,
    });
  });

  it("inserts a tab at the end of the value", () => {
    expect(
      insertComposerTabIndent({
        value: "code",
        selectionStart: 4,
        selectionEnd: 4,
      }),
    ).toEqual({
      value: "code\t",
      selectionStart: 5,
      selectionEnd: 5,
    });
  });

  it("inserts a tab into an empty string", () => {
    expect(
      insertComposerTabIndent({
        value: "",
        selectionStart: 0,
        selectionEnd: 0,
      }),
    ).toEqual({
      value: "\t",
      selectionStart: 1,
      selectionEnd: 1,
    });
  });

  it("replaces a non-empty selection with a single tab", () => {
    expect(
      insertComposerTabIndent({
        value: "hello world",
        selectionStart: 6,
        selectionEnd: 11,
      }),
    ).toEqual({
      value: "hello \t",
      selectionStart: 7,
      selectionEnd: 7,
    });
  });

  it("replaces a full-value selection with a single tab", () => {
    expect(
      insertComposerTabIndent({
        value: "snippet",
        selectionStart: 0,
        selectionEnd: 7,
      }),
    ).toEqual({
      value: "\t",
      selectionStart: 1,
      selectionEnd: 1,
    });
  });

  it("replaces a multi-line selection with a single tab", () => {
    expect(
      insertComposerTabIndent({
        value: "line1\nline2\nline3",
        selectionStart: 6,
        selectionEnd: 11,
      }),
    ).toEqual({
      value: "line1\n\t\nline3",
      selectionStart: 7,
      selectionEnd: 7,
    });
  });

  it("normalizes inverted selection ranges before inserting", () => {
    expect(
      insertComposerTabIndent({
        value: "abcde",
        selectionStart: 4,
        selectionEnd: 1,
      }),
    ).toEqual({
      value: "a\te",
      selectionStart: 2,
      selectionEnd: 2,
    });
  });

  it("clamps nullish selection to the end of the value", () => {
    expect(
      insertComposerTabIndent({
        value: "abc",
        selectionStart: null,
        selectionEnd: undefined,
      }),
    ).toEqual({
      value: "abc\t",
      selectionStart: 4,
      selectionEnd: 4,
    });
  });

  it("clamps out-of-range selection indices", () => {
    expect(
      insertComposerTabIndent({
        value: "ab",
        selectionStart: -3,
        selectionEnd: 99,
      }),
    ).toEqual({
      value: "\t",
      selectionStart: 1,
      selectionEnd: 1,
    });
  });

  it("truncates fractional selection indices", () => {
    expect(
      insertComposerTabIndent({
        value: "abcd",
        selectionStart: 1.9,
        selectionEnd: 2.1,
      }),
    ).toEqual({
      value: "a\tcd",
      selectionStart: 2,
      selectionEnd: 2,
    });
  });

  it("treats NaN/Infinity selection as end of value", () => {
    expect(
      insertComposerTabIndent({
        value: "xy",
        selectionStart: Number.NaN,
        selectionEnd: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      value: "xy\t",
      selectionStart: 3,
      selectionEnd: 3,
    });
  });

  it("preserves surrounding unicode text when inserting", () => {
    expect(
      insertComposerTabIndent({
        value: "你好世界",
        selectionStart: 2,
        selectionEnd: 2,
      }),
    ).toEqual({
      value: "你好\t世界",
      selectionStart: 3,
      selectionEnd: 3,
    });
  });

  it("supports nested indentation for code snippets (repeated insert)", () => {
    let state = {
      value: "function f() {\nreturn 1\n}",
      selectionStart: 15,
      selectionEnd: 15,
    };

    state = insertComposerTabIndent(state);
    expect(state).toEqual({
      value: "function f() {\n\treturn 1\n}",
      selectionStart: 16,
      selectionEnd: 16,
    });

    state = insertComposerTabIndent(state);
    expect(state).toEqual({
      value: "function f() {\n\t\treturn 1\n}",
      selectionStart: 17,
      selectionEnd: 17,
    });
  });

  it("keeps a single tab character (U+0009), not spaces", () => {
    const result = insertComposerTabIndent({
      value: "x",
      selectionStart: 0,
      selectionEnd: 0,
    });
    expect(result.value).toBe("\tx");
    expect(result.value.charCodeAt(0)).toBe(0x09);
    expect(result.value.includes(" ")).toBe(false);
  });

  it("length grows by 1 when inserting into empty selection", () => {
    const value = "abcdef";
    const result = insertComposerTabIndent({
      value,
      selectionStart: 3,
      selectionEnd: 3,
    });
    expect(result.value.length).toBe(value.length + 1);
  });

  it("length shrinks by (selectionWidth - 1) when replacing a selection", () => {
    const value = "abcdef";
    const result = insertComposerTabIndent({
      value,
      selectionStart: 1,
      selectionEnd: 4,
    });
    // removed 3 chars, added 1 tab → net -2
    expect(result.value.length).toBe(value.length - 2);
    expect(result.value).toBe("a\tef");
  });
});

describe("isPlainTabKey", () => {
  it("accepts plain Tab", () => {
    expect(isPlainTabKey(plainTabEvent())).toBe(true);
  });

  it("rejects Shift+Tab so agent mode-cycle is not stolen", () => {
    expect(isPlainTabKey(plainTabEvent({ shiftKey: true }))).toBe(false);
  });

  it("rejects Meta+Tab / Ctrl+Tab / Alt+Tab", () => {
    expect(isPlainTabKey(plainTabEvent({ metaKey: true }))).toBe(false);
    expect(isPlainTabKey(plainTabEvent({ ctrlKey: true }))).toBe(false);
    expect(isPlainTabKey(plainTabEvent({ altKey: true }))).toBe(false);
  });

  it("rejects non-Tab keys", () => {
    expect(isPlainTabKey(plainTabEvent({ key: "Enter" }))).toBe(false);
    expect(isPlainTabKey(plainTabEvent({ key: " " }))).toBe(false);
    expect(isPlainTabKey(plainTabEvent({ key: "t" }))).toBe(false);
  });

  it("treats missing modifier flags as false", () => {
    expect(isPlainTabKey({ key: "Tab" })).toBe(true);
  });
});

describe("resolveComposerTabKeyDown — bug vs fix simulation", () => {
  /**
   * Bug #1347 simulation:
   * Without our insert policy, plain Tab is not consumed → browser focus navigation.
   * The fix must return kind:"insert" so the host can preventDefault.
   */
  it("FIX: plain Tab in composer text resolves to insert (prevents focus leave)", () => {
    const result = resolveComposerTabKeyDown(
      baseResolve({
        value: "const x = 1",
        selectionStart: 0,
        selectionEnd: 0,
      }),
    );
    expect(result).toEqual({
      kind: "insert",
      value: "\tconst x = 1",
      selectionStart: 1,
      selectionEnd: 1,
    });
  });

  it("BUG-class regression: inserting mid-line code indentation", () => {
    const result = resolveComposerTabKeyDown(
      baseResolve({
        value: "if (ok) {\nconsole.log(1)\n}",
        selectionStart: 10,
        selectionEnd: 10,
      }),
    );
    expect(result).toEqual({
      kind: "insert",
      value: "if (ok) {\n\tconsole.log(1)\n}",
      selectionStart: 11,
      selectionEnd: 11,
    });
  });

  it("does not claim Shift+Tab (mode-cycle must keep working)", () => {
    expect(
      resolveComposerTabKeyDown(
        baseResolve({
          event: plainTabEvent({ shiftKey: true }),
        }),
      ),
    ).toEqual({ kind: "ignore" });
  });

  it("does not claim modified Tabs", () => {
    for (const event of [
      plainTabEvent({ metaKey: true }),
      plainTabEvent({ ctrlKey: true }),
      plainTabEvent({ altKey: true }),
    ]) {
      expect(resolveComposerTabKeyDown(baseResolve({ event }))).toEqual({ kind: "ignore" });
    }
  });

  it("ignores plain Tab while disabled (a11y: focus can leave)", () => {
    expect(resolveComposerTabKeyDown(baseResolve({ disabled: true }))).toEqual({
      kind: "ignore",
    });
  });

  it("ignores plain Tab while dictating", () => {
    expect(resolveComposerTabKeyDown(baseResolve({ isDictating: true }))).toEqual({
      kind: "ignore",
    });
  });

  it("ignores plain Tab during realtime voice for current agent", () => {
    expect(
      resolveComposerTabKeyDown(baseResolve({ isRealtimeVoiceForCurrentAgent: true })),
    ).toEqual({ kind: "ignore" });
  });

  it("autocomplete wins when onKeyPressCallback handles Tab", () => {
    const selected: string[] = [];
    const result = resolveComposerTabKeyDown(
      baseResolve({
        value: "/help",
        selectionStart: 5,
        selectionEnd: 5,
        onKeyPressCallback: (event) => {
          event.preventDefault();
          selected.push(event.key);
          return true;
        },
      }),
    );
    expect(result).toEqual({ kind: "autocomplete", shouldPreventDefault: true });
    expect(selected).toEqual(["Tab"]);
  });

  it("does not insert indent when autocomplete handles Tab (no insert payload)", () => {
    const result = resolveComposerTabKeyDown(
      baseResolve({
        value: "before",
        selectionStart: 3,
        selectionEnd: 3,
        onKeyPressCallback: () => true,
      }),
    );
    expect(result).toEqual({ kind: "autocomplete", shouldPreventDefault: false });
  });

  it("records shouldPreventDefault when autocomplete asks for it", () => {
    expect(
      resolveComposerTabKeyDown(
        baseResolve({
          onKeyPressCallback: (event) => {
            event.preventDefault();
            return true;
          },
        }),
      ),
    ).toEqual({ kind: "autocomplete", shouldPreventDefault: true });
  });

  it("inserts indent when autocomplete is not visible (callback returns false)", () => {
    const result = resolveComposerTabKeyDown(
      baseResolve({
        value: "cmd",
        selectionStart: 3,
        selectionEnd: 3,
        onKeyPressCallback: () => false,
      }),
    );
    expect(result).toEqual({
      kind: "insert",
      value: "cmd\t",
      selectionStart: 4,
      selectionEnd: 4,
    });
  });

  it("inserts indent when no autocomplete callback is provided", () => {
    const result = resolveComposerTabKeyDown(
      baseResolve({
        value: "a",
        selectionStart: 1,
        selectionEnd: 1,
        onKeyPressCallback: undefined,
      }),
    );
    expect(result).toEqual({
      kind: "insert",
      value: "a\t",
      selectionStart: 2,
      selectionEnd: 2,
    });
  });

  it("gates take priority over autocomplete (disabled + callback present)", () => {
    const callback = vi.fn(() => true);
    const result = resolveComposerTabKeyDown(
      baseResolve({
        disabled: true,
        onKeyPressCallback: callback,
      }),
    );
    expect(result).toEqual({ kind: "ignore" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("passes key Tab to autocomplete callback", () => {
    const keys: string[] = [];
    resolveComposerTabKeyDown(
      baseResolve({
        onKeyPressCallback: (event) => {
          keys.push(event.key);
          return false;
        },
      }),
    );
    expect(keys).toEqual(["Tab"]);
  });
});

describe("applyComposerTabKeyDownResult — host side-effects", () => {
  function createTextArea(initial = "") {
    const calls: Array<[number, number]> = [];
    const state = { value: initial };
    return {
      state,
      calls,
      handle: {
        get value() {
          return state.value;
        },
        set value(next: string) {
          state.value = next;
        },
        setSelectionRange(start: number, end: number) {
          calls.push([start, end]);
        },
      },
    };
  }

  it("insert: preventDefault + update value/ref/onChange + restore selection", () => {
    const textarea = createTextArea("ab");
    const valueRef = { current: "ab" };
    const changes: string[] = [];
    const preventDefault = vi.fn();
    const scheduled: Array<() => void> = [];

    const result = resolveComposerTabKeyDown(
      baseResolve({
        value: "ab",
        selectionStart: 1,
        selectionEnd: 1,
      }),
    );
    expect(result.kind).toBe("insert");

    const prevented = applyComposerTabKeyDownResult({
      result,
      valueRef,
      textarea: textarea.handle,
      onChangeText: (next) => changes.push(next),
      preventDefault,
      scheduleSelectionRestore: (restore) => scheduled.push(restore),
    });

    expect(prevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(valueRef.current).toBe("a\tb");
    expect(textarea.state.value).toBe("a\tb");
    expect(changes).toEqual(["a\tb"]);
    // immediate restore + scheduled restore
    expect(textarea.calls).toEqual([[2, 2]]);
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(textarea.calls).toEqual([
      [2, 2],
      [2, 2],
    ]);
  });

  it("ignore: does not preventDefault or mutate text (bug path if used for plain Tab by mistake)", () => {
    const textarea = createTextArea("stay");
    const valueRef = { current: "stay" };
    const changes: string[] = [];
    const preventDefault = vi.fn();

    const prevented = applyComposerTabKeyDownResult({
      result: { kind: "ignore" },
      valueRef,
      textarea: textarea.handle,
      onChangeText: (next) => changes.push(next),
      preventDefault,
    });

    expect(prevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(valueRef.current).toBe("stay");
    expect(textarea.state.value).toBe("stay");
    expect(changes).toEqual([]);
  });

  it("autocomplete without preventDefault request: leaves browser default alone and does not insert", () => {
    const textarea = createTextArea("/cmd");
    const valueRef = { current: "/cmd" };
    const changes: string[] = [];
    const preventDefault = vi.fn();

    const prevented = applyComposerTabKeyDownResult({
      result: { kind: "autocomplete", shouldPreventDefault: false },
      valueRef,
      textarea: textarea.handle,
      onChangeText: (next) => changes.push(next),
      preventDefault,
    });

    expect(prevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(valueRef.current).toBe("/cmd");
    expect(changes).toEqual([]);
  });

  it("autocomplete with preventDefault request: stops focus navigation without inserting", () => {
    const textarea = createTextArea("/cmd");
    const valueRef = { current: "/cmd" };
    const changes: string[] = [];
    const preventDefault = vi.fn();

    const prevented = applyComposerTabKeyDownResult({
      result: { kind: "autocomplete", shouldPreventDefault: true },
      valueRef,
      textarea: textarea.handle,
      onChangeText: (next) => changes.push(next),
      preventDefault,
    });

    expect(prevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(valueRef.current).toBe("/cmd");
    expect(changes).toEqual([]);
  });

  it("simulates sequential Tab presses as a user typing indented code", () => {
    let value = "";
    let selectionStart = 0;
    let selectionEnd = 0;
    const valueRef = { current: value };
    const textarea = createTextArea(value);

    for (let i = 0; i < 3; i++) {
      const resolved = resolveComposerTabKeyDown(
        baseResolve({
          value: valueRef.current,
          selectionStart,
          selectionEnd,
        }),
      );
      applyComposerTabKeyDownResult({
        result: resolved,
        valueRef,
        textarea: textarea.handle,
        onChangeText: (next) => {
          value = next;
        },
        preventDefault: () => undefined,
        scheduleSelectionRestore: () => undefined,
      });
      if (resolved.kind === "insert") {
        selectionStart = resolved.selectionStart;
        selectionEnd = resolved.selectionEnd;
      }
    }

    expect(value).toBe("\t\t\t");
    expect(valueRef.current).toBe("\t\t\t");
    expect(selectionStart).toBe(3);
    expect(selectionEnd).toBe(3);
  });
});

describe("resolve + apply end-to-end policy (no React)", () => {
  it("mirrors the intended web keydown handler for a normal indent", () => {
    const valueRef = { current: "print('hi')" };
    const changes: string[] = [];
    let defaultPrevented = false;
    const textarea = {
      value: valueRef.current,
      selectionStart: 0 as number | null,
      selectionEnd: 0 as number | null,
      setSelectionRange: vi.fn(),
    };

    const resolved = resolveComposerTabKeyDown({
      event: plainTabEvent(),
      value: valueRef.current,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
      disabled: false,
      isDictating: false,
      isRealtimeVoiceForCurrentAgent: false,
      onKeyPressCallback: () => false,
    });

    applyComposerTabKeyDownResult({
      result: resolved,
      valueRef,
      textarea,
      onChangeText: (next) => changes.push(next),
      preventDefault: () => {
        defaultPrevented = true;
      },
      scheduleSelectionRestore: () => undefined,
    });

    expect(defaultPrevented).toBe(true);
    expect(changes).toEqual(["\tprint('hi')"]);
    expect(valueRef.current).toBe("\tprint('hi')");
    expect(textarea.value).toBe("\tprint('hi')");
    expect(textarea.setSelectionRange).toHaveBeenCalledWith(1, 1);
  });

  it("autocomplete-open path never mutates composer text but still preventDefaults", () => {
    const valueRef = { current: "/status" };
    const changes: string[] = [];
    let defaultPrevented = false;

    const resolved = resolveComposerTabKeyDown({
      event: plainTabEvent(),
      value: valueRef.current,
      selectionStart: 7,
      selectionEnd: 7,
      disabled: false,
      isDictating: false,
      isRealtimeVoiceForCurrentAgent: false,
      onKeyPressCallback: (event) => {
        event.preventDefault();
        return true;
      },
    });

    applyComposerTabKeyDownResult({
      result: resolved,
      valueRef,
      textarea: { value: valueRef.current, setSelectionRange: vi.fn() },
      onChangeText: (next) => changes.push(next),
      preventDefault: () => {
        defaultPrevented = true;
      },
    });

    expect(resolved).toEqual({ kind: "autocomplete", shouldPreventDefault: true });
    expect(defaultPrevented).toBe(true);
    expect(changes).toEqual([]);
    expect(valueRef.current).toBe("/status");
  });

  /**
   * Simulates the pre-fix bug class: if we ignored plain Tab (kind:ignore),
   * preventDefault is never called → browser moves focus. Assert the fix path
   * never regresses to ignore for an enabled plain Tab.
   */
  it("never ignores enabled plain Tab without autocomplete (bug #1347 guard)", () => {
    const result = resolveComposerTabKeyDown(
      baseResolve({
        value: "ready",
        selectionStart: 0,
        selectionEnd: 0,
        disabled: false,
        isDictating: false,
        isRealtimeVoiceForCurrentAgent: false,
        onKeyPressCallback: () => false,
      }),
    );
    expect(result.kind).not.toBe("ignore");
    expect(result.kind).toBe("insert");
  });
});

/**
 * Mirrors packages/app/src/hooks/use-autocomplete.ts Tab contract:
 * when suggestions are visible and non-empty, Tab preventDefaults and returns true.
 */
function simulateUseAutocompleteTabHandler(input: {
  isVisible: boolean;
  optionsLength: number;
}): (event: { key: string; preventDefault: () => void }) => boolean {
  return (event) => {
    if (!input.isVisible || input.optionsLength === 0) {
      return false;
    }
    if (event.key === "Tab" || event.key === "Enter") {
      event.preventDefault();
      return true;
    }
    return false;
  };
}

describe("integration contract with useAutocomplete Tab handling", () => {
  it("when suggestions are open, Tab completes and does not indent", () => {
    const valueRef = { current: "/hel" };
    const changes: string[] = [];
    let defaultPrevented = false;

    const resolved = resolveComposerTabKeyDown(
      baseResolve({
        value: valueRef.current,
        selectionStart: 4,
        selectionEnd: 4,
        onKeyPressCallback: simulateUseAutocompleteTabHandler({
          isVisible: true,
          optionsLength: 3,
        }),
      }),
    );

    applyComposerTabKeyDownResult({
      result: resolved,
      valueRef,
      textarea: { value: valueRef.current },
      onChangeText: (next) => changes.push(next),
      preventDefault: () => {
        defaultPrevented = true;
      },
    });

    expect(resolved).toEqual({ kind: "autocomplete", shouldPreventDefault: true });
    expect(defaultPrevented).toBe(true);
    expect(changes).toEqual([]);
    expect(valueRef.current).toBe("/hel");
  });

  it("when suggestions are closed, Tab indents (issue repro: conversation input)", () => {
    const valueRef = { current: "  if (x) {\n" };
    // caret after newline — typical code-indent spot
    const caret = valueRef.current.length;
    const changes: string[] = [];
    let defaultPrevented = false;

    const resolved = resolveComposerTabKeyDown(
      baseResolve({
        value: valueRef.current,
        selectionStart: caret,
        selectionEnd: caret,
        onKeyPressCallback: simulateUseAutocompleteTabHandler({
          isVisible: false,
          optionsLength: 0,
        }),
      }),
    );

    applyComposerTabKeyDownResult({
      result: resolved,
      valueRef,
      textarea: {
        value: valueRef.current,
        setSelectionRange: () => undefined,
      },
      onChangeText: (next) => {
        changes.push(next);
        valueRef.current = next;
      },
      preventDefault: () => {
        defaultPrevented = true;
      },
      scheduleSelectionRestore: () => undefined,
    });

    expect(defaultPrevented).toBe(true);
    expect(resolved).toEqual({
      kind: "insert",
      value: "  if (x) {\n\t",
      selectionStart: caret + 1,
      selectionEnd: caret + 1,
    });
    expect(changes).toEqual(["  if (x) {\n\t"]);
  });

  it("when suggestions visible but empty list, Tab falls through to indent", () => {
    const resolved = resolveComposerTabKeyDown(
      baseResolve({
        value: "/",
        selectionStart: 1,
        selectionEnd: 1,
        onKeyPressCallback: simulateUseAutocompleteTabHandler({
          isVisible: true,
          optionsLength: 0,
        }),
      }),
    );
    expect(resolved).toEqual({
      kind: "insert",
      value: "/\t",
      selectionStart: 2,
      selectionEnd: 2,
    });
  });
});

describe("adversarial / mutation-style guards", () => {
  it("insert result always contains exactly one new U+0009 for empty caret", () => {
    const before = "alpha\nbeta";
    const resolved = resolveComposerTabKeyDown(
      baseResolve({
        value: before,
        selectionStart: 6,
        selectionEnd: 6,
      }),
    );
    expect(resolved.kind).toBe("insert");
    if (resolved.kind !== "insert") return;
    const added = [...resolved.value].filter((ch) => ch === "\t").length;
    const existing = [...before].filter((ch) => ch === "\t").length;
    expect(added).toBe(existing + 1);
    expect(resolved.value.includes("    ")).toBe(false);
  });

  it("ignore path never prevents default (focus can leave — intentional for gates)", () => {
    const preventDefault = vi.fn();
    for (const result of [
      resolveComposerTabKeyDown(baseResolve({ disabled: true })),
      resolveComposerTabKeyDown(baseResolve({ isDictating: true })),
      resolveComposerTabKeyDown(baseResolve({ isRealtimeVoiceForCurrentAgent: true })),
      resolveComposerTabKeyDown(baseResolve({ event: plainTabEvent({ shiftKey: true }) })),
    ]) {
      expect(result.kind).toBe("ignore");
      applyComposerTabKeyDownResult({
        result,
        valueRef: { current: "x" },
        textarea: { value: "x" },
        onChangeText: () => {
          throw new Error("onChangeText must not run on ignore");
        },
        preventDefault,
      });
    }
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("BUG simulation: if host forgot preventDefault on insert, focus would leave — apply always preventDefaults", () => {
    const preventDefault = vi.fn();
    applyComposerTabKeyDownResult({
      result: {
        kind: "insert",
        value: "\t",
        selectionStart: 1,
        selectionEnd: 1,
      },
      valueRef: { current: "" },
      textarea: { value: "", setSelectionRange: () => undefined },
      onChangeText: () => undefined,
      preventDefault,
      scheduleSelectionRestore: () => undefined,
    });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });
});
