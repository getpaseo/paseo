import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(__dirname, "..");

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(entryPath);
    }
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

function containsEagerStyleRead(initializer: ts.Expression): boolean {
  if (ts.isFunctionLike(initializer)) {
    return false;
  }

  let found = false;

  function visit(node: ts.Node): void {
    if (node !== initializer && ts.isFunctionLike(node)) {
      return;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text !== "StyleSheet" &&
      /styles$/i.test(node.expression.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(initializer);
  return found;
}

function findEagerModuleStyleReads(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement)) {
      return [];
    }
    return statement.declarationList.declarations.flatMap((declaration) => {
      if (!declaration.initializer || !containsEagerStyleRead(declaration.initializer)) {
        return [];
      }
      const line =
        sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line + 1;
      return [`${path.relative(SOURCE_ROOT, filePath)}:${line}`];
    });
  });
}

describe("Unistyles module scope", () => {
  it("does not materialize style proxies before the persisted theme loads", () => {
    const violations = listSourceFiles(SOURCE_ROOT).flatMap(findEagerModuleStyleReads);

    expect(violations).toEqual([]);
  });
});
