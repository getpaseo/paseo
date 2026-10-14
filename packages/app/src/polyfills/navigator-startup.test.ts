import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

it("installs navigator before the app entry loads its other dependencies", () => {
  const entry = ts.createSourceFile(
    "index.ts",
    readFileSync(new URL("../../index.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
  );
  const firstImport = entry.statements.find(ts.isImportDeclaration);
  expect(firstImport?.moduleSpecifier.getText(entry)).toBe('"./src/polyfills/install-early"');
  const early = ts.createSourceFile(
    "install-early.ts",
    readFileSync(new URL("./install-early.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
  );
  expect(
    early.statements.some(
      (statement) =>
        ts.isExpressionStatement(statement) &&
        ts.isCallExpression(statement.expression) &&
        statement.expression.expression.getText(early) === "polyfillNavigator",
    ),
  ).toBe(true);
});

it("initializes the native navigator before evaluating the real terminal dependency", () => {
  const require = createRequire(import.meta.url);
  const terminalSource = readFileSync(require.resolve("@xterm/headless"), "utf8");
  const navigatorSource = ts.transpileModule(
    readFileSync(new URL("./navigator.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  // Each VM owns its globals, so the native navigator shape never replaces
  // globals in the test runner or needs a native-module mock.
  const uninitialized = createContext({
    navigator: {},
    window: {},
    module: { exports: {} },
    exports: {},
  });
  expect(() => runInContext(terminalSource, uninitialized)).toThrow(/includes/);

  const initialized = createContext({
    navigator: {},
    window: {},
    module: { exports: {} },
    exports: {},
  });
  runInContext(navigatorSource, initialized);
  runInContext("exports.polyfillNavigator()", initialized);
  expect(() => runInContext(terminalSource, initialized)).not.toThrow();
});
