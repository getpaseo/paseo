import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import Parser from "tree-sitter";
import {
  getSupportedLanguageExtensions,
  isGrammarBackedLanguage,
  resolveLanguageEntry,
  type LanguageRegistryEntry,
} from "./language-registry.js";

const require = createRequire(import.meta.url);

export type HighlightStyle =
  | "keyword"
  | "comment"
  | "string"
  | "number"
  | "literal"
  | "function"
  | "definition"
  | "class"
  | "type"
  | "tag"
  | "attribute"
  | "property"
  | "variable"
  | "operator"
  | "punctuation"
  | "regexp"
  | "escape"
  | "meta"
  | "heading"
  | "link";

export interface HighlightToken {
  start: number;
  end: number;
  style: HighlightStyle;
}

type StyleMapLine = Array<HighlightStyle | null>;

interface LoadedLanguageRuntime {
  parser: Parser;
  query: Parser.Query | null;
}

const CAPTURE_STYLE_EXACT = new Map<string, HighlightStyle>([
  ["keyword", "keyword"],
  ["comment", "comment"],
  ["string", "string"],
  ["number", "number"],
  ["float", "number"],
  ["integer", "number"],
  ["constant", "literal"],
  ["boolean", "literal"],
  ["function", "function"],
  ["method", "function"],
  ["constructor", "class"],
  ["function_definition", "definition"],
  ["class", "class"],
  ["type", "type"],
  ["tag", "tag"],
  ["attribute", "attribute"],
  ["property", "property"],
  ["variable", "variable"],
  ["operator", "operator"],
  ["punctuation", "punctuation"],
  ["escape", "escape"],
  ["regex", "regexp"],
  ["regexp", "regexp"],
  ["module", "meta"],
  ["include", "meta"],
  ["namespace", "meta"],
  ["heading", "heading"],
  ["title", "heading"],
  ["link", "link"],
  ["uri", "link"],
]);

const CAPTURE_STYLE_PREFIX: Array<[string, HighlightStyle]> = [
  ["keyword", "keyword"],
  ["comment", "comment"],
  ["string", "string"],
  ["number", "number"],
  ["float", "number"],
  ["integer", "number"],
  ["constant", "literal"],
  ["boolean", "literal"],
  ["function", "function"],
  ["method", "function"],
  ["constructor", "class"],
  ["class", "class"],
  ["type", "type"],
  ["tag", "tag"],
  ["attribute", "attribute"],
  ["property", "property"],
  ["variable", "variable"],
  ["parameter", "variable"],
  ["operator", "operator"],
  ["punctuation", "punctuation"],
  ["escape", "escape"],
  ["regex", "regexp"],
  ["regexp", "regexp"],
  ["module", "meta"],
  ["namespace", "meta"],
  ["include", "meta"],
  ["heading", "heading"],
  ["title", "heading"],
  ["link", "link"],
  ["uri", "link"],
];

const runtimeCache = new Map<string, LoadedLanguageRuntime | null>();

function getParserRuntimeForFile(filename: string): LoadedLanguageRuntime | null {
  const entry = resolveLanguageEntry(filename);
  if (!entry?.grammarPackage) {
    return null;
  }

  const existing = runtimeCache.get(entry.id);
  if (existing !== undefined) {
    return existing;
  }

  const loaded = loadLanguageRuntime(entry);
  runtimeCache.set(entry.id, loaded);
  return loaded;
}

function loadLanguageRuntime(
  entry: LanguageRegistryEntry
): LoadedLanguageRuntime | null {
  if (!entry.grammarPackage) {
    return null;
  }

  try {
    const grammarModule = require(entry.grammarPackage) as unknown;
    const language = resolveLanguageExport({
      grammarModule,
      grammarExport: entry.grammarExport,
    });
    if (!language) {
      return null;
    }

    const parser = new Parser();
    parser.setLanguage(language);

    const querySource = loadHighlightsQuerySource(entry);
    const query = querySource ? new Parser.Query(language, querySource) : null;

    return { parser, query };
  } catch {
    return null;
  }
}

function resolveLanguageExport({
  grammarModule,
  grammarExport,
}: {
  grammarModule: unknown;
  grammarExport?: string;
}): unknown {
  if (grammarExport) {
    const named = (grammarModule as Record<string, unknown> | undefined)?.[
      grammarExport
    ];
    if (named) {
      return named;
    }
  }

  const defaultExport = (grammarModule as { default?: unknown } | undefined)
    ?.default;
  if (defaultExport) {
    return defaultExport;
  }

  if (grammarModule) {
    return grammarModule;
  }

  return null;
}

function loadHighlightsQuerySource(entry: LanguageRegistryEntry): string | null {
  if (!entry.grammarPackage) {
    return null;
  }

  const packageJsonPath = require.resolve(
    `${entry.grammarPackage}/package.json`
  );
  const packageDir = path.dirname(packageJsonPath);
  const queryReferences = getHighlightQueryReferences(entry, packageDir);
  const sources: string[] = [];

  for (const reference of queryReferences) {
    const queryPath = resolveQueryReferencePath(reference, packageDir);
    if (!queryPath || !existsSync(queryPath)) {
      continue;
    }

    const source = readFileSync(queryPath, "utf-8");
    if (source.trim().length > 0) {
      sources.push(source);
    }
  }

  if (sources.length === 0) {
    return null;
  }

  return sources.join("\n");
}

function getHighlightQueryReferences(
  entry: LanguageRegistryEntry,
  packageDir: string
): string[] {
  const fromTreeSitterJson = getHighlightQueriesFromTreeSitterJson(
    entry,
    packageDir
  );
  if (fromTreeSitterJson.length > 0) {
    return fromTreeSitterJson;
  }
  return [entry.highlightsQueryPath ?? "queries/highlights.scm"];
}

function getHighlightQueriesFromTreeSitterJson(
  entry: LanguageRegistryEntry,
  packageDir: string
): string[] {
  const treeSitterMetadataPath = path.join(packageDir, "tree-sitter.json");
  if (!existsSync(treeSitterMetadataPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(treeSitterMetadataPath, "utf-8")) as {
      grammars?: Array<{ name?: string; highlights?: string | string[] }>;
    };
    const grammars = Array.isArray(parsed.grammars) ? parsed.grammars : [];
    if (grammars.length === 0) {
      return [];
    }

    const targetGrammarName =
      entry.grammarName ?? entry.grammarExport ?? entry.id;
    const grammar =
      grammars.find((candidate) => candidate.name === targetGrammarName) ??
      grammars[0];

    const highlights = grammar?.highlights;
    if (typeof highlights === "string") {
      return [highlights];
    }
    return Array.isArray(highlights) ? highlights : [];
  } catch {
    return [];
  }
}

function resolveQueryReferencePath(
  reference: string,
  packageDir: string
): string | null {
  if (path.isAbsolute(reference)) {
    return reference;
  }

  const localPath = path.join(packageDir, reference);
  if (existsSync(localPath)) {
    return localPath;
  }

  if (!reference.startsWith("node_modules/")) {
    return null;
  }

  const withoutPrefix = reference.slice("node_modules/".length);
  const segments = withoutPrefix.split("/");
  if (segments.length === 0) {
    return null;
  }

  const packageName =
    segments[0].startsWith("@") && segments.length >= 2
      ? `${segments[0]}/${segments[1]}`
      : segments[0];
  const packagePathStart = packageName.startsWith("@") ? 2 : 1;
  const packageRelativePath = segments.slice(packagePathStart).join("/");

  try {
    const dependencyPackageJson = require.resolve(`${packageName}/package.json`);
    const dependencyDir = path.dirname(dependencyPackageJson);
    return path.join(dependencyDir, packageRelativePath);
  } catch {
    return null;
  }
}

function mapCaptureNameToStyle(captureName: string): HighlightStyle | null {
  let candidate = captureName;
  while (candidate.length > 0) {
    const exact = CAPTURE_STYLE_EXACT.get(candidate);
    if (exact) {
      return exact;
    }
    const separator = candidate.lastIndexOf(".");
    if (separator === -1) {
      break;
    }
    candidate = candidate.slice(0, separator);
  }

  for (const [prefix, style] of CAPTURE_STYLE_PREFIX) {
    if (captureName === prefix || captureName.startsWith(`${prefix}.`)) {
      return style;
    }
  }

  return null;
}

function byteColumnToCodeUnitIndex(line: string, byteColumn: number): number {
  if (byteColumn <= 0 || line.length === 0) {
    return 0;
  }

  let currentBytes = 0;
  let currentCodeUnits = 0;

  for (const character of line) {
    const characterBytes = Buffer.byteLength(character);
    const nextBytes = currentBytes + characterBytes;
    if (nextBytes > byteColumn) {
      break;
    }
    currentBytes = nextBytes;
    currentCodeUnits += character.length;
  }

  return Math.min(currentCodeUnits, line.length);
}

function applyCaptureToStyleMap({
  lineStyles,
  lines,
  style,
  start,
  end,
}: {
  lineStyles: StyleMapLine[];
  lines: string[];
  style: HighlightStyle;
  start: { row: number; column: number };
  end: { row: number; column: number };
}): void {
  const maxLineIndex = lines.length - 1;
  if (maxLineIndex < 0) {
    return;
  }

  const startRow = Math.max(0, Math.min(start.row, maxLineIndex));
  const endRow = Math.max(0, Math.min(end.row, maxLineIndex));
  if (endRow < startRow) {
    return;
  }

  for (let row = startRow; row <= endRow; row++) {
    const line = lines[row] ?? "";
    if (line.length === 0) {
      continue;
    }

    const lineByteLength = Buffer.byteLength(line);
    const startByte = row === startRow ? start.column : 0;
    const endByte = row === endRow ? end.column : lineByteLength;
    if (endByte <= startByte) {
      continue;
    }

    const startIndex = byteColumnToCodeUnitIndex(line, startByte);
    const endIndex = byteColumnToCodeUnitIndex(line, endByte);
    if (endIndex <= startIndex) {
      continue;
    }

    const rowStyles = lineStyles[row];
    for (let i = startIndex; i < endIndex; i++) {
      rowStyles[i] = style;
    }
  }
}

function buildLineTokens(styles: StyleMapLine): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  let currentStyle: HighlightStyle | null = null;
  let tokenStart = 0;

  for (let i = 0; i <= styles.length; i++) {
    const style = i < styles.length ? styles[i] : null;
    if (style === currentStyle) {
      continue;
    }

    if (currentStyle !== null && i > tokenStart) {
      tokens.push({ start: tokenStart, end: i, style: currentStyle });
    }

    currentStyle = style;
    tokenStart = i;
  }

  return tokens;
}

export function highlightCode(code: string, filename: string): HighlightToken[][] {
  const lines = code.split("\n");
  const runtime = getParserRuntimeForFile(filename);
  if (!runtime?.query) {
    return lines.map(() => []);
  }

  const tree = runtime.parser.parse(code);
  const lineStyles: StyleMapLine[] = lines.map((line) =>
    new Array<HighlightStyle | null>(line.length).fill(null)
  );
  const captures = runtime.query.captures(tree.rootNode);

  for (const capture of captures) {
    const style = mapCaptureNameToStyle(capture.name);
    if (!style) {
      continue;
    }

    applyCaptureToStyleMap({
      lineStyles,
      lines,
      style,
      start: capture.node.startPosition,
      end: capture.node.endPosition,
    });
  }

  return lineStyles.map(buildLineTokens);
}

export function highlightLine(line: string, filename: string): HighlightToken[] {
  const result = highlightCode(line, filename);
  return result[0] ?? [];
}

export function getSupportedExtensions(): string[] {
  return getSupportedLanguageExtensions().map((extension) =>
    extension.startsWith(".") ? extension.slice(1) : extension
  );
}

export function isLanguageSupported(filename: string): boolean {
  return isGrammarBackedLanguage(filename);
}
