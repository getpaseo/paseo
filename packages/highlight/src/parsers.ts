import {
  defineLanguageFacet,
  Language,
  languageDataProp,
  StreamLanguage,
} from "@codemirror/language";
import { dart } from "@codemirror/legacy-modes/mode/clike";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { parser as jsParser } from "@lezer/javascript";
import { parser as jsonParser } from "@lezer/json";
import { parser as cssParser } from "@lezer/css";
import { parser as cppParser } from "@lezer/cpp";
import { parser as goParser } from "@lezer/go";
import { parser as htmlParser } from "@lezer/html";
import { parser as javaParser } from "@lezer/java";
import { parser as pythonParser } from "@lezer/python";
import { parser as markdownParser, type MarkdownParser } from "@lezer/markdown";
import { parser as phpParser } from "@lezer/php";
import { parser as rustParser } from "@lezer/rust";
import { parser as xmlParser } from "@lezer/xml";
import { parser as yamlParser } from "@lezer/yaml";
import { parser as elixirParser } from "lezer-elixir";
import type { Parser } from "@lezer/common";
import type { LRParser } from "@lezer/lr";
import { csharpLanguage } from "./csharp/language.js";
import { astroParser } from "./astro/parser.js";
import { vueParser } from "./vue/parser.js";
import { nixLanguage } from "./nix/language.js";
import { hclLanguage } from "./hcl/language.js";
import { parser as svelteBaseParser } from "./svelte/parser.js";
import { configureNesting, defaultNesting } from "./svelte/nesting.js";

const cStyleComments = { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } };
const hashComments = { commentTokens: { line: "#" } };
const cssComments = { commentTokens: { block: { open: "/*", close: "*/" } } };
const markupComments = { commentTokens: { block: { open: "<!--", close: "-->" } } };
const mdxComments = { commentTokens: { block: { open: "{/*", close: "*/}" } } };

function language(
  parser: LRParser | MarkdownParser,
  languageData: Parameters<typeof defineLanguageFacet>[0] = {},
): Language {
  const data = defineLanguageFacet(languageData);
  return new Language(
    data,
    parser.configure({
      props: [languageDataProp.add((node) => (node.isTop ? data : undefined))],
    }),
  );
}

const shellLanguage = StreamLanguage.define(shell);
const dockerfileLanguage = StreamLanguage.define(dockerFile);

const languagesByExtension: Record<string, Language> = {
  // JavaScript/TypeScript
  js: language(jsParser, cStyleComments),
  jsx: language(jsParser.configure({ dialect: "jsx" }), cStyleComments),
  ts: language(jsParser.configure({ dialect: "ts" }), cStyleComments),
  tsx: language(jsParser.configure({ dialect: "ts jsx" }), cStyleComments),
  mjs: language(jsParser, cStyleComments),
  cjs: language(jsParser, cStyleComments),
  // C / C++ / Objective-C
  c: language(cppParser, cStyleComments),
  h: language(cppParser, cStyleComments),
  cc: language(cppParser, cStyleComments),
  cpp: language(cppParser, cStyleComments),
  cxx: language(cppParser, cStyleComments),
  hpp: language(cppParser, cStyleComments),
  hxx: language(cppParser, cStyleComments),
  m: language(cppParser, cStyleComments),
  mm: language(cppParser, cStyleComments),
  // JSON
  json: language(jsonParser),
  // CSS
  css: language(cssParser, cssComments),
  scss: language(cssParser, cStyleComments),
  // HTML
  html: language(htmlParser, markupComments),
  htm: language(htmlParser, markupComments),
  // Svelte
  svelte: language(
    svelteBaseParser.configure({ wrap: configureNesting(defaultNesting) }),
    markupComments,
  ),
  // Astro
  astro: new Language(defineLanguageFacet(), astroParser),
  // Vue
  vue: language(vueParser, markupComments),
  // XML
  xml: language(xmlParser, markupComments),
  // Java
  java: language(javaParser, cStyleComments),
  // Python
  py: language(pythonParser, hashComments),
  // Go
  go: language(goParser, cStyleComments),
  // PHP
  php: language(phpParser, cStyleComments),
  // YAML
  yaml: language(yamlParser, hashComments),
  yml: language(yamlParser, hashComments),
  // Rust
  rs: language(rustParser, cStyleComments),
  // Shell
  sh: shellLanguage,
  bash: shellLanguage,
  zsh: shellLanguage,
  // Docker
  dockerfile: dockerfileLanguage,
  // Swift
  swift: StreamLanguage.define(swift),
  // Dart
  dart: StreamLanguage.define(dart),
  // C#
  cs: csharpLanguage,
  // Nix
  nix: nixLanguage,
  // Terraform / HCL
  tf: hclLanguage,
  tfvars: hclLanguage,
  hcl: hclLanguage,
  // Elixir
  ex: language(elixirParser, hashComments),
  exs: language(elixirParser, hashComments),
  // Markdown
  md: language(markdownParser, markupComments),
  mdx: language(markdownParser, mdxComments),
};

export function getLanguageForFile(filename: string): Language | null {
  const basename = filename.slice(
    Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\")) + 1,
  );
  if (basename.toLowerCase() === "dockerfile") return dockerfileLanguage;

  const dot = basename.lastIndexOf(".");
  // Callers also pass bare language keys for code fences.
  if (dot === -1 && basename !== filename) return null;

  const ext = basename.slice(dot + 1).toLowerCase();
  if (!ext) return null;
  return languagesByExtension[ext] ?? null;
}

export function getParserForFile(filename: string): Parser | null {
  return getLanguageForFile(filename)?.parser ?? null;
}

export function isLanguageSupported(filename: string): boolean {
  return getParserForFile(filename) !== null;
}

export function getSupportedExtensions(): string[] {
  return Object.keys(languagesByExtension);
}
