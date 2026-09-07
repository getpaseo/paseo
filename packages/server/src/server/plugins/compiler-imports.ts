import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { ImportKind } from "esbuild";
import type { Node, NamedImportBindings, NamedExportBindings } from "typescript";

const nodeRequire = createRequire(import.meta.url);

export type PluginImportKind = ImportKind | "type-reference";

interface ModuleImport {
  specifier: string;
  kind: PluginImportKind;
  typeOnly: boolean;
}

// Keep the TypeScript compiler off daemon startup. esbuild erases these edges, so
// ownership validation needs the original syntax and declaration-aware resolution.
export function createPluginImportReader(directory: string) {
  const ts = nodeRequire("typescript") as typeof import("typescript");
  const configFile = ts.findConfigFile(directory, ts.sys.fileExists);
  const config = configFile
    ? ts.getParsedCommandLineOfConfigFile(
        configFile,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
          },
        },
      )
    : undefined;
  const options = {
    ...config?.options,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
  };
  const cache = ts.createModuleResolutionCache(directory, (file) => file, options);
  return {
    resolve(specifier: string, importer: string, kind: PluginImportKind): string | undefined {
      const resolved =
        kind === "type-reference"
          ? ts.resolveTypeReferenceDirective(specifier, importer, options, ts.sys)
              .resolvedTypeReferenceDirective?.resolvedFileName
          : ts.resolveModuleName(
              specifier,
              importer,
              options,
              ts.sys,
              cache,
              undefined,
              kind === "require-call" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
            ).resolvedModule?.resolvedFileName;
      return resolved ? realpathSync.native(resolved) : undefined;
    },
    read(file: string): ModuleImport[] {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const imports: ModuleImport[] = [];
      function add(
        node: Node | undefined,
        typeOnly: boolean,
        kind: ImportKind = "import-statement",
      ) {
        if (node && ts.isStringLiteralLike(node)) {
          imports.push({
            specifier: node.text,
            kind,
            typeOnly: source.isDeclarationFile || typeOnly,
          });
        }
      }
      function onlyTypeBindings(
        bindings: NamedImportBindings | NamedExportBindings | undefined,
      ): boolean {
        return (
          !!bindings &&
          (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((element) => element.isTypeOnly)
        );
      }
      function visit(node: Node): void {
        if (ts.isImportDeclaration(node)) {
          const clause = node.importClause;
          const typeOnly =
            !!clause?.isTypeOnly || (!clause?.name && onlyTypeBindings(clause?.namedBindings));
          add(node.moduleSpecifier, typeOnly);
        } else if (ts.isExportDeclaration(node)) {
          add(node.moduleSpecifier, node.isTypeOnly || onlyTypeBindings(node.exportClause));
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
          add(node.argument.literal, true);
        } else if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference)
        ) {
          add(node.moduleReference.expression, node.isTypeOnly, "require-call");
        } else if (ts.isCallExpression(node)) {
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
            add(node.arguments[0], false, "dynamic-import");
          else if (ts.isIdentifier(node.expression) && node.expression.text === "require")
            add(node.arguments[0], false, "require-call");
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      for (const reference of source.referencedFiles) {
        imports.push({
          specifier: path.resolve(path.dirname(file), reference.fileName),
          kind: "import-statement",
          typeOnly: true,
        });
      }
      for (const reference of source.typeReferenceDirectives) {
        imports.push({ specifier: reference.fileName, kind: "type-reference", typeOnly: true });
      }
      return imports;
    },
  };
}
