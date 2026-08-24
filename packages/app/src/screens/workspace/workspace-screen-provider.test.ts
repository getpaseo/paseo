import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const workspaceScreenPath = new URL("./workspace-screen.tsx", import.meta.url);

function getJsxTagName(node: ts.Node): string | null {
  if (ts.isJsxElement(node)) {
    return node.openingElement.tagName.getText();
  }
  if (ts.isJsxSelfClosingElement(node)) {
    return node.tagName.getText();
  }
  return null;
}

function findJsxElements(sourceFile: ts.SourceFile, tagName: string): ts.Node[] {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (getJsxTagName(node) === tagName) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

function hasJsxAncestor(node: ts.Node, tagName: string): boolean {
  let parent = node.parent;
  while (parent) {
    if (getJsxTagName(parent) === tagName) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

describe("workspace screen provider wiring", () => {
  it("provides a new-tab launcher to the native non-compact fallback tab row", () => {
    const source = readFileSync(workspaceScreenPath, "utf8");
    const sourceFile = ts.createSourceFile(
      workspaceScreenPath.pathname,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const fallbackTabRows = findJsxElements(sourceFile, "WorkspaceDesktopTabsRow");

    expect(fallbackTabRows).toHaveLength(1);
    expect(hasJsxAncestor(fallbackTabRows[0]!, "NewTabLauncherProvider")).toBe(true);
  });
});
