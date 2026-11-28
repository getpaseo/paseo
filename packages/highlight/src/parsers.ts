import { defineLanguageFacet, Language, StreamLanguage } from "@codemirror/language";
import { dart, kotlin, scala } from "@codemirror/legacy-modes/mode/clike";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { r } from "@codemirror/legacy-modes/mode/r";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { parser as jsParser } from "@lezer/javascript";
import { parser as jsonParser } from "@lezer/json";
import { parser as cssParser } from "@lezer/css";
import { parser as cppParser } from "@lezer/cpp";
import { parser as goParser } from "@lezer/go";
import { parser as htmlParser } from "@lezer/html";
import { parser as javaParser } from "@lezer/java";
import { parser as pythonParser } from "@lezer/python";
import { parser as markdownParser } from "@lezer/markdown";
import { parser as phpParser } from "@lezer/php";
import { parser as rustParser } from "@lezer/rust";
import { parser as xmlParser } from "@lezer/xml";
import { parser as yamlParser } from "@lezer/yaml";
import { parser as elixirParser } from "lezer-elixir";
import type { Parser } from "@lezer/common";
import { csharpLanguage } from "./csharp/language.js";
import { astroParser } from "./astro/parser.js";
import { vueParser } from "./vue/parser.js";
import { nixLanguage } from "./nix/language.js";
import { hclLanguage } from "./hcl/language.js";
import { parser as svelteBaseParser } from "./svelte/parser.js";
import { configureNesting, defaultNesting } from "./svelte/nesting.js";

function language(parser: Parser): Language {
  return new Language(defineLanguageFacet(), parser);
}

const shellLanguage = StreamLanguage.define(shell);
const dockerfileLanguage = StreamLanguage.define(dockerFile);
const diffLanguage = StreamLanguage.define({
  ...diff,
  token(stream, state) {
    const token = diff.token?.(stream, state) ?? null;
    if (!token || token === "error") return null;
    // Legacy diff mode prefixes trailing-whitespace tokens with "error ", which triggers
    // CodeMirror's "Unknown highlighting tag error" warning on compound tokens.
    return token.startsWith("error ") ? token.slice("error ".length) : token;
  },
});
const rubyLanguage = StreamLanguage.define(ruby);
const kotlinLanguage = StreamLanguage.define(kotlin);
const scalaLanguage = StreamLanguage.define(scala);
const powerShellLanguage = StreamLanguage.define(powerShell);
const groovyLanguage = StreamLanguage.define(groovy);
const cmakeLanguage = StreamLanguage.define(cmake);
const propertiesLanguage = StreamLanguage.define(properties);
const perlLanguage = StreamLanguage.define(perl);
const stexLanguage = StreamLanguage.define(stex);

const languagesByExtension: Record<string, Language> = {
  // JavaScript/TypeScript
  js: language(jsParser),
  jsx: language(jsParser.configure({ dialect: "jsx" })),
  ts: language(jsParser.configure({ dialect: "ts" })),
  tsx: language(jsParser.configure({ dialect: "ts jsx" })),
  mjs: language(jsParser),
  cjs: language(jsParser),
  // C / C++ / Objective-C
  c: language(cppParser),
  h: language(cppParser),
  cc: language(cppParser),
  cpp: language(cppParser),
  cxx: language(cppParser),
  hpp: language(cppParser),
  hxx: language(cppParser),
  m: language(cppParser),
  mm: language(cppParser),
  // JSON
  json: language(jsonParser),
  // CSS
  css: language(cssParser),
  scss: language(cssParser),
  // HTML
  html: language(htmlParser),
  htm: language(htmlParser),
  // Svelte
  svelte: language(svelteBaseParser.configure({ wrap: configureNesting(defaultNesting) })),
  // Astro
  astro: language(astroParser),
  // Vue
  vue: language(vueParser),
  // XML
  xml: language(xmlParser),
  // Java
  java: language(javaParser),
  // Python
  py: language(pythonParser),
  // Go
  go: language(goParser),
  // PHP
  php: language(phpParser),
  // YAML
  yaml: language(yamlParser),
  yml: language(yamlParser),
  // Rust
  rs: language(rustParser),
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
  // Diff / patch (unified diff format)
  diff: diffLanguage,
  patch: diffLanguage,
  // Ruby
  rb: rubyLanguage,
  rbw: rubyLanguage,
  rake: rubyLanguage,
  gemspec: rubyLanguage,
  ru: rubyLanguage,
  jbuilder: rubyLanguage,
  podspec: rubyLanguage,
  thor: rubyLanguage,
  // Kotlin
  kt: kotlinLanguage,
  kts: kotlinLanguage,
  // Scala
  scala: scalaLanguage,
  sc: scalaLanguage,
  // TOML
  toml: StreamLanguage.define(toml),
  // SQL
  sql: StreamLanguage.define(standardSQL),
  // Lua
  lua: StreamLanguage.define(lua),
  // Protobuf
  proto: StreamLanguage.define(protobuf),
  // PowerShell
  ps1: powerShellLanguage,
  psm1: powerShellLanguage,
  psd1: powerShellLanguage,
  // Groovy / Gradle
  groovy: groovyLanguage,
  gradle: groovyLanguage,
  // CMake
  cmake: cmakeLanguage,
  // Properties / INI
  properties: propertiesLanguage,
  ini: propertiesLanguage,
  conf: propertiesLanguage,
  // R
  r: StreamLanguage.define(r),
  // Perl
  pl: perlLanguage,
  pm: perlLanguage,
  // LaTeX / TeX
  tex: stexLanguage,
  sty: stexLanguage,
  cls: stexLanguage,
  // C#
  cs: csharpLanguage,
  // Nix
  nix: nixLanguage,
  // Terraform / HCL
  tf: hclLanguage,
  tfvars: hclLanguage,
  hcl: hclLanguage,
  // Elixir
  ex: language(elixirParser),
  exs: language(elixirParser),
  // Markdown
  md: language(markdownParser),
  mdx: language(markdownParser),
};

/** Exact-basename files whose whole name identifies the language, matched case-sensitively. */
const languagesByFilename = new Map<string, Language>([
  // Ruby
  ["Gemfile", rubyLanguage],
  ["Rakefile", rubyLanguage],
  ["Guardfile", rubyLanguage],
  ["Capfile", rubyLanguage],
  ["Podfile", rubyLanguage],
  ["Vagrantfile", rubyLanguage],
  ["Brewfile", rubyLanguage],
  ["Berksfile", rubyLanguage],
  ["Thorfile", rubyLanguage],
  ["Fastfile", rubyLanguage],
  ["Appfile", rubyLanguage],
  ["Dangerfile", rubyLanguage],
  // CMake
  ["CMakeLists.txt", cmakeLanguage],
]);

export function getLanguageForFile(filename: string): Language | null {
  const basename = filename.slice(
    Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\")) + 1,
  );
  if (basename.toLowerCase() === "dockerfile") return dockerfileLanguage;
  const byFilename = languagesByFilename.get(basename);
  if (byFilename) return byFilename;

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
