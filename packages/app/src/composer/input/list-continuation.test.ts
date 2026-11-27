import { describe, expect, it } from "vitest";
import { continueMarkdownList } from "./list-continuation";

// Types a newline at `|` and returns the text and caret the composer ends up with.
function pressEnter(withCaret: string, caretReportedAfterEdit = false): string | null {
  const caret = withCaret.indexOf("|");
  const previous = withCaret.replace("|", "");
  const next = `${previous.slice(0, caret)}\n${previous.slice(caret)}`;
  const result = continueMarkdownList(previous, next, caretReportedAfterEdit ? caret + 1 : caret);
  if (!result) return null;
  const { text, selection } = result;
  return `${text.slice(0, selection.start)}|${text.slice(selection.start)}`;
}

describe("continueMarkdownList", () => {
  it("continues bullet lists with the same marker and indent", () => {
    expect(pressEnter("- one|")).toBe("- one\n- |");
    expect(pressEnter("intro\n  * two|")).toBe("intro\n  * two\n  * |");
    expect(pressEnter("+ three|")).toBe("+ three\n+ |");
  });

  it("increments ordered lists", () => {
    expect(pressEnter("1. one\n2. two|")).toBe("1. one\n2. two\n3. |");
    expect(pressEnter("9) nine|")).toBe("9) nine\n10) |");
  });

  it("continues task lists with an unchecked box", () => {
    expect(pressEnter("- [x] done|")).toBe("- [x] done\n- [ ] |");
  });

  it("moves the text after the caret into the new item", () => {
    expect(pressEnter("- one| two")).toBe("- one\n- |two");
  });

  it("ends the list on an empty item", () => {
    expect(pressEnter("- one\n- |")).toBe("- one\n|");
    expect(pressEnter("1. one\n2. |\nafter")).toBe("1. one\n|\nafter");
    expect(pressEnter("- [ ] |")).toBe("|");
  });

  it("accepts a caret reported after the edit", () => {
    expect(pressEnter("- one|", true)).toBe("- one\n- |");
  });

  it("leaves other newlines alone", () => {
    expect(pressEnter("plain text|")).toBeNull();
    expect(pressEnter("- - -|")).toBeNull();
    expect(pressEnter("```\n- in code|")).toBeNull();
    expect(pressEnter("1.5 apples|")).toBeNull();
    expect(continueMarkdownList("- one", "- one\n- two", 5)).toBeNull();
  });
});
