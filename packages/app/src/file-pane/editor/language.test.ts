import { EditorState, type Transaction } from "@codemirror/state";
import { toggleComment } from "@codemirror/commands";
import { getLanguageForFile } from "@getpaseo/highlight";
import { expect, test } from "vitest";

test.each([
  ["source.ts", "const value = 1;", "// const value = 1;"],
  ["source.py", "value = 1", "# value = 1"],
  ["source.css", "body {}", "/* body {} */"],
  ["source.html", "<p>text</p>", "<!-- <p>text</p> -->"],
  ["source.md", "text", "<!-- text -->"],
  ["source.ex", "value = 1", "# value = 1"],
  ["source.cs", "var value = 1;", "// var value = 1;"],
  ["source.nix", "1", "# 1"],
])("toggles the comment and restores the source in %s", (filename, doc, commented) => {
  const language = getLanguageForFile(filename);
  if (!language) throw new Error(`Missing language for ${filename}`);
  let state = EditorState.create({ doc, extensions: [language] });
  const target = {
    get state() {
      return state;
    },
    dispatch(transaction: Transaction) {
      state = transaction.state;
    },
  };
  expect(toggleComment(target)).toBe(true);
  expect(state.doc.toString()).toBe(commented);
  expect(toggleComment(target)).toBe(true);
  expect(state.doc.toString()).toBe(doc);
});

test("keeps JSON comment-free", () => {
  const language = getLanguageForFile("data.json");
  if (!language) throw new Error("Missing JSON language");
  const state = EditorState.create({ doc: "{}", extensions: [language] });
  expect(
    toggleComment({
      state,
      dispatch() {
        throw new Error("JSON must not be edited");
      },
    }),
  ).toBe(false);
});
