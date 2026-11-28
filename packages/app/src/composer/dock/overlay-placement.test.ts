import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

it("keeps dock overlays outside keyboard translation in every native layout", () => {
  const source = ts.createSourceFile(
    "dock.tsx",
    readFileSync(new URL("./index.native.tsx", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let surfaces = 0;
  function visit(node: ts.Node) {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(source) === "KeyboardTranslateView"
    ) {
      surfaces++;
      function assertStationary(child: ts.Node) {
        if (ts.isJsxExpression(child))
          expect(child.expression?.getText(source)).not.toBe("overlay");
        ts.forEachChild(child, assertStationary);
      }
      ts.forEachChild(node, assertStationary);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(surfaces).toBe(2);
});
