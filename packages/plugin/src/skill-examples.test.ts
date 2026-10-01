import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const skill = readFileSync(path.join(repository, "skills/paseo-plugin/SKILL.md"), "utf8");

function sectionCode(heading: string): string {
  const section = skill.slice(skill.indexOf(`\n## ${heading}\n`));
  const code = /```tsx\n([\s\S]*?)\n```/.exec(section)?.[1];
  if (!code) throw new Error(`No tsx example under "${heading}"`);
  return code;
}

// Checks the example as a plugin client file, with the same options as the plugin examples.
function typeErrors(code: string): string[] {
  const configPath = path.join(repository, "packages/plugin/tsconfig.examples.json");
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));
  const file = path.join(repository, "plugin-examples/skill-example/client/example.tsx");
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, language, ...rest) =>
    path.resolve(name) === file
      ? ts.createSourceFile(name, code, language)
      : getSourceFile.call(host, name, language, ...rest);
  host.fileExists = (name) => path.resolve(name) === file || ts.sys.fileExists(name);
  const program = ts.createProgram([file], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

describe("paseo-plugin skill examples", () => {
  it("composer pill example typechecks against the plugin SDK", () => {
    expect(typeErrors(sectionCode("Add a composer pill"))).toEqual([]);
  });
});
