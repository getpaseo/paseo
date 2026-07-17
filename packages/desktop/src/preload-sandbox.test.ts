import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PASEO_BROWSER_PROFILE_PARTITION } from "./features/browser-profile.js";

// The preload runs inside Electron's sandbox and is tsc-compiled (not bundled), so at
// runtime it may only load Electron's sandbox allowlist. Any other module (local or
// third-party) emits a require() that the sandbox rejects synchronously, aborting the
// preload before contextBridge.exposeInMainWorld runs and leaving window.paseoDesktop
// undefined. That regression (0.1.108, #2103) is what this test guards against.
const SANDBOX_ALLOWLIST = new Set(["electron"]);

const preloadPath = join(dirname(fileURLToPath(import.meta.url)), "preload.ts");

// Collect every module specifier that survives to emitted JavaScript as a runtime load.
// Type-only imports/exports are erased by tsc and are therefore ignored.
function runtimeModuleSpecifiers(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "preload.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const specifiers: string[] = [];

  const record = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) {
      specifiers.push(node.text);
    }
  };

  const isTypeOnlyImport = (node: ts.ImportDeclaration): boolean => {
    const clause = node.importClause;
    if (!clause) {
      // Side-effect import: `import "./x.js"` — always a runtime load.
      return false;
    }
    if (clause.isTypeOnly) {
      return true;
    }
    const bindings = clause.namedBindings;
    // `import { type A, type B } from "x"` erases entirely; a default or namespace
    // binding, or any value-named binding, keeps the module at runtime.
    return (
      clause.name === undefined &&
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly)
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!isTypeOnlyImport(node)) {
        record(node.moduleSpecifier);
      }
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      record(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        record(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

describe("preload sandbox safety", () => {
  it("only loads Electron's sandbox allowlist at runtime", () => {
    const source = readFileSync(preloadPath, "utf8");
    const disallowed = runtimeModuleSpecifiers(source).filter(
      (specifier) => !SANDBOX_ALLOWLIST.has(specifier),
    );
    expect(disallowed).toEqual([]);
  });

  it("inlines the browser profile partition instead of importing it", () => {
    const source = readFileSync(preloadPath, "utf8");
    const match = source.match(/const\s+PASEO_BROWSER_PROFILE_PARTITION\s*=\s*"([^"]+)"/);
    expect(
      match,
      "PASEO_BROWSER_PROFILE_PARTITION not found as a double-quoted string literal in preload.ts",
    ).not.toBeNull();
    expect(match![1]).toBe(PASEO_BROWSER_PROFILE_PARTITION);
  });
});
