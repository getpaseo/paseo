import { parse } from "@babel/parser";
import { readFileSync } from "node:fs";
import type { ImportKind } from "esbuild";

// esbuild erases type dependencies. Read the original syntax before validating ownership.
export function readPluginModuleImports(file: string): { specifier: string; kind: ImportKind }[] {
  const ast = parse(readFileSync(file, "utf8"), {
    sourceType: "unambiguous",
    plugins: ["typescript", "decorators", ...(file.endsWith("x") ? ["jsx" as const] : [])],
  });
  const imports: { specifier: string; kind: ImportKind }[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    let source: unknown;
    let kind: ImportKind = "import-statement";
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        source = node.source;
        break;
      case "TSImportType":
        source = node.argument;
        break;
      case "TSExternalModuleReference":
        source = node.expression;
        kind = "require-call";
        break;
      case "ImportExpression":
        source = node.source;
        kind = "dynamic-import";
        break;
      case "CallExpression": {
        const callee = node.callee as Record<string, unknown>;
        if (
          callee.type === "Import" ||
          (callee.type === "Identifier" && callee.name === "require")
        ) {
          source = (node.arguments as unknown[])[0];
          kind = callee.type === "Import" ? "dynamic-import" : "require-call";
        }
        break;
      }
    }
    const specifier = stringLiteral(source);
    if (specifier !== undefined) imports.push({ specifier, kind });
    Object.values(node).forEach(visit);
  }
  visit(ast.program);
  return imports;
}

function stringLiteral(source: unknown): string | undefined {
  if (
    source &&
    typeof source === "object" &&
    "type" in source &&
    source.type === "StringLiteral" &&
    "value" in source &&
    typeof source.value === "string"
  )
    return source.value;
  return undefined;
}
