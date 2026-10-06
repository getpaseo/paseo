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
  ["source.mdx", "text", "{/* text */}"],
  ["source.ex", "value = 1", "# value = 1"],
  ["source.cs", "var value = 1;", "// var value = 1;"],
  ["source.nix", "1", "# 1"],
])("toggles the comment and restores the source in %s", (filename, doc, commented) => {
  const language = getLanguageForFile(filename);
  if (!language) throw new Error(`Missing language for ${filename}`);
  const target = editorTarget(EditorState.create({ doc, extensions: [language] }));
  expect(toggleComment(target)).toBe(true);
  expect(target.state.doc.toString()).toBe(commented);
  expect(toggleComment(target)).toBe(true);
  expect(target.state.doc.toString()).toBe(doc);
});

const jsxView = [
  "const view = (",
  "  <div",
  '    className="x"',
  "    onClick={() => go()}",
  "  >",
  "    text",
  "    {value}",
  "    <span />",
  "{flag}",
  "<br />",
  "    <Foo",
  '      a="1"',
  "    />",
  "    {items.map(() => {",
  "      const item = 1;",
  "    })}",
  "  </div>",
  ");",
].join("\n");

test.each([
  ["view.jsx", "text", "{/* text */}"],
  ["view.tsx", "text", "{/* text */}"],
  ["view.tsx", "{value}", "{/* {value} */}"],
  ["view.tsx", "<span />", "{/* <span /> */}"],
  ["view.tsx", "{flag}", "{/* {flag} */}"],
  ["view.tsx", "<br />", "{/* <br /> */}"],
  ["view.tsx", 'className="x"', '// className="x"'],
  ["view.tsx", "onClick={() => go()}", "// onClick={() => go()}"],
  ["view.tsx", 'a="1"', '// a="1"'],
  ["view.tsx", "const item = 1;", "// const item = 1;"],
])("toggles %s line %s as %s", (filename, line, commented) => {
  const language = getLanguageForFile(filename);
  if (!language) throw new Error(`Missing language for ${filename}`);
  const target = editorTarget(
    EditorState.create({
      doc: jsxView,
      extensions: [language],
      selection: { anchor: jsxView.indexOf(line) },
    }),
  );
  expect(toggleComment(target)).toBe(true);
  expect(target.state.doc.toString()).toBe(jsxView.replace(line, commented));
  expect(toggleComment(target)).toBe(true);
  expect(target.state.doc.toString()).toBe(jsxView);
});

function editorTarget(initial: EditorState) {
  let state = initial;
  return {
    get state() {
      return state;
    },
    dispatch(transaction: Transaction) {
      state = transaction.state;
    },
  };
}

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
