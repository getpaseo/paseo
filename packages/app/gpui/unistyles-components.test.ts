import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parse } from "@babel/parser";
import { expect, test } from "vitest";

const require = createRequire(import.meta.url);
const GPUI_DIR = import.meta.dirname;

// The Unistyles Babel plugin rewrites `import { X } from "react-native"` to
// `react-native-unistyles/components/native/X`, and the GPUI Metro config sends
// every such path to this one adapter. A component Unistyles wraps but the
// adapter does not export arrives as `undefined` and React throws
// "Element type is invalid" when it renders.
const ADAPTER = path.join(GPUI_DIR, "adapters/unistyles-components.js");

// NativeText and NativeView are reached only through
// `react-native/Libraries/...` imports, which the app does not use.
const NOT_REDIRECTED_FROM_REACT_NATIVE = new Set(["NativeText", "NativeView"]);

function unistylesWrappedComponents(): string[] {
  const unistylesRoot = path.dirname(require.resolve("react-native-unistyles/package.json"));
  return readdirSync(path.join(unistylesRoot, "components/native"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NOT_REDIRECTED_FROM_REACT_NATIVE.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function adapterExports(): Set<string> {
  const ast = parse(readFileSync(ADAPTER, "utf8"), { sourceType: "module" });
  const names = new Set<string>();
  for (const node of ast.program.body) {
    if (node.type !== "ExportNamedDeclaration" || node.declaration?.type !== "VariableDeclaration")
      continue;
    for (const declarator of node.declaration.declarations) {
      if (declarator.id.type === "Identifier") names.add(declarator.id.name);
    }
  }
  return names;
}

test("the GPUI Unistyles adapter exports every component the Unistyles plugin redirects", () => {
  const wrapped = unistylesWrappedComponents();
  expect(wrapped).toContain("RefreshControl");
  const exported = adapterExports();
  expect(wrapped.filter((name) => !exported.has(name))).toEqual([]);
});
