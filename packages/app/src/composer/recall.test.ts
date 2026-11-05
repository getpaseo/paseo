import { describe, expect, it } from "vitest";
import type { ComposerKeyPressEvent } from "@/composer/input/input";
import { ComposerRecall } from "@/composer/recall";

const SENT = ["add tests", "fix the auth bug"];

function press(
  key: string,
  text: string,
  options: { caret?: number; selectionEnd?: number; hasModifier?: boolean } = {},
): ComposerKeyPressEvent {
  const caret = options.caret ?? text.length;
  return {
    key,
    hasModifier: options.hasModifier ?? false,
    preventDefault: () => undefined,
    input: { text, selection: { start: caret, end: options.selectionEnd ?? caret } },
  };
}

/** Drives recall the way the composer does: each result becomes the composer text, caret at the end. */
function composerWithRecall(sent: readonly string[] = SENT) {
  const recall = new ComposerRecall();
  let text = "";
  return {
    recall,
    get text() {
      return text;
    },
    type(next: string) {
      text = next;
    },
    press(key: string, options: { caret?: number; hasModifier?: boolean } = {}) {
      const result = recall.handleKeyPress(press(key, text, options), () => sent);
      if (result !== null) text = result;
      return result;
    },
  };
}

describe("ComposerRecall", () => {
  it("walks back through sent messages and forward to an empty composer", () => {
    const composer = composerWithRecall();

    expect(composer.press("ArrowUp")).toBe("add tests");
    expect(composer.press("ArrowUp")).toBe("fix the auth bug");
    expect(composer.press("ArrowDown")).toBe("add tests");
    expect(composer.press("ArrowDown")).toBe("");
    expect(composer.recall.isShowing(composer.text)).toBe(false);
  });

  it("leaves the caret to the input past the oldest message", () => {
    const composer = composerWithRecall();
    composer.press("ArrowUp");
    composer.press("ArrowUp");

    expect(composer.press("ArrowUp")).toBeNull();
    expect(composer.text).toBe("fix the auth bug");
  });

  it("only starts from an empty composer", () => {
    const composer = composerWithRecall();
    composer.type("half written");

    expect(composer.press("ArrowUp")).toBeNull();
    expect(composer.press("ArrowDown")).toBeNull();
  });

  it("ignores Down from an empty composer and Up with no history", () => {
    expect(composerWithRecall().press("ArrowDown")).toBeNull();
    expect(composerWithRecall([]).press("ArrowUp")).toBeNull();
  });

  it("hands the arrows back to the caret once the recalled message is edited", () => {
    const composer = composerWithRecall();
    composer.press("ArrowUp");
    composer.type("add tests for login");

    expect(composer.recall.isShowing(composer.text)).toBe(false);
    expect(composer.press("ArrowUp")).toBeNull();
    expect(composer.press("ArrowDown")).toBeNull();
  });

  it("moves between lines of a multi-line message before changing message", () => {
    const composer = composerWithRecall(["first line\nsecond line", "older"]);
    composer.press("ArrowUp");

    expect(composer.press("ArrowUp", { caret: "first line\nsec".length })).toBeNull();
    expect(composer.press("ArrowUp", { caret: 3 })).toBe("older");
    expect(composer.press("ArrowDown")).toBe("first line\nsecond line");
    expect(composer.press("ArrowDown", { caret: 3 })).toBeNull();
    expect(composer.press("ArrowDown")).toBe("");
  });

  it("ignores modified arrows, other keys, and a selection", () => {
    const composer = composerWithRecall();

    expect(composer.press("ArrowUp", { hasModifier: true })).toBeNull();
    expect(composer.press("Enter")).toBeNull();
    composer.press("ArrowUp");
    const recall = composer.recall;
    expect(
      recall.handleKeyPress(
        press("ArrowUp", "add tests", { caret: 0, selectionEnd: 3 }),
        () => SENT,
      ),
    ).toBeNull();
  });
});
