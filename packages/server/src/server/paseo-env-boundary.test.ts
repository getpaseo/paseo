import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(testDir, "..");
const repoRoot = path.resolve(sourceRoot, "../../..");
const serverExportsPath = path.join(testDir, "exports.ts");

const privateEnvBuilderNames = [
  "buildExternalExecPathProcessEnv",
  "buildExternalProcessEnv",
  "buildInternalProcessEnv",
] as const;
const removedEnvHelperNames = ["createExternalExecPathProcessEnv"] as const;
const rawSubprocessCallNames = ["spawn", "spawnFn", "spawnSync", "execFileSync"] as const;
const safeSubprocessCallNames = ["execCommand", "spawnProcess"] as const;
const finalizedEnvBuilderNames = [
  "applyProviderEnv",
  "createExternalProcessEnv",
  "createExternalCommandProcessEnv",
  "createProviderEnv",
] as const;

interface SourceFile {
  absolutePath: string;
  relativePath: string;
  contents: string;
}

interface Violation {
  file: string;
  line: number;
  message: string;
}

function isProductionTypeScriptFile(filePath: string): boolean {
  if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) {
    return false;
  }
  const relativePath = path.relative(sourceRoot, filePath).split(path.sep).join("/");
  if (
    relativePath === "server/paseo-env.ts" ||
    relativePath === "server/paseo-env-boundary.test.ts"
  ) {
    return false;
  }
  if (
    /(?:^|\/)__tests__\//.test(relativePath) ||
    /(?:^|\/)test-utils\//.test(relativePath) ||
    /(?:^|\/)daemon-e2e\//.test(relativePath)
  ) {
    return false;
  }
  return !/(?:\.test|\.e2e\.test|\.integration\.test)\.ts$/.test(relativePath);
}

async function collectProductionTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectProductionTypeScriptFiles(absolutePath);
      }
      return isProductionTypeScriptFile(absolutePath) ? [absolutePath] : [];
    }),
  );
  return files.flat().sort();
}

async function readProductionSourceFiles(): Promise<SourceFile[]> {
  const filePaths = await collectProductionTypeScriptFiles(sourceRoot);
  return Promise.all(
    filePaths.map(async (absolutePath) => ({
      absolutePath,
      relativePath: path.relative(sourceRoot, absolutePath).split(path.sep).join("/"),
      contents: await readFile(absolutePath, "utf8"),
    })),
  );
}

async function collectTextFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "build", ".git"].includes(entry.name)) {
          return [];
        }
        return collectTextFiles(absolutePath);
      }
      if (!entry.isFile()) {
        return [];
      }
      if (
        /\.(?:ts|tsx|js|mjs|cjs|sh|cmd)$/.test(entry.name) ||
        path.basename(path.dirname(absolutePath)) === "bin"
      ) {
        return [absolutePath];
      }
      return [];
    }),
  );
  return files.flat().sort();
}

async function readRepositoryTextFiles(relativeDirs: string[]): Promise<SourceFile[]> {
  const filePaths = (
    await Promise.all(relativeDirs.map((dir) => collectTextFiles(path.join(repoRoot, dir))))
  )
    .flat()
    .sort();
  return Promise.all(
    filePaths.map(async (absolutePath) => ({
      absolutePath,
      relativePath: path.relative(repoRoot, absolutePath).split(path.sep).join("/"),
      contents: await readFile(absolutePath, "utf8"),
    })),
  );
}

function lineForIndex(contents: string, index: number): number {
  return contents.slice(0, index).split("\n").length;
}

function findAll(contents: string, pattern: RegExp): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  for (const match of contents.matchAll(pattern)) {
    matches.push(match);
  }
  return matches;
}

function findCallEnd(contents: string, openParenIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = openParenIndex; index < contents.length; index++) {
    const char = contents[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(") {
      depth++;
      continue;
    }
    if (char === ")") {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }

  return contents.length;
}

function lineTextForIndex(contents: string, index: number): string {
  const lineStart = contents.lastIndexOf("\n", index) + 1;
  const lineEnd = contents.indexOf("\n", index);
  return contents.slice(lineStart, lineEnd === -1 ? contents.length : lineEnd);
}

function isSubprocessCallMatch(contents: string, match: RegExpExecArray): boolean {
  const lineText = lineTextForIndex(contents, match.index).trim();
  if (lineText.startsWith("*") || lineText.startsWith("//")) {
    return false;
  }
  if (/^(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/.test(lineText)) {
    return false;
  }
  if (/^(?:protected|private|public)\s+(?:async\s+)?\w+\s*\(/.test(lineText)) {
    return false;
  }

  const previousChar = contents[match.index - 1] ?? "";
  if (previousChar === ".") {
    return false;
  }
  return true;
}

function formatViolations(violations: Violation[]): string {
  return violations
    .map((violation) => `${violation.file}:${violation.line} ${violation.message}`)
    .join("\n");
}

function isPaseoNodeEnvWriterAllowed(relativePath: string): boolean {
  return (
    relativePath === "packages/server/src/server/paseo-env.ts" ||
    relativePath.includes(".test.") ||
    relativePath.includes(".e2e.") ||
    relativePath.includes("/test-utils/") ||
    relativePath.includes("launcher") ||
    relativePath === "packages/cli/src/commands/daemon/local-daemon.ts" ||
    relativePath.startsWith("packages/desktop/bin/") ||
    relativePath.startsWith("scripts/")
  );
}

describe("Paseo env boundary", () => {
  it("does not pass raw process.env directly to subprocess env options", async () => {
    const violations: Violation[] = [];

    for (const file of await readProductionSourceFiles()) {
      const directProcessEnv = findAll(file.contents, /\benv\s*:\s*process\.env\b/g);
      for (const match of directProcessEnv) {
        violations.push({
          file: file.relativePath,
          line: lineForIndex(file.contents, match.index),
          message: "subprocess env must use createExternalProcessEnv instead of process.env",
        });
      }

      const spreadProcessEnv = findAll(
        file.contents,
        /\benv\s*:\s*\{\s*\.\.\.\s*\(?\s*process\.env\b/g,
      );
      for (const match of spreadProcessEnv) {
        violations.push({
          file: file.relativePath,
          line: lineForIndex(file.contents, match.index),
          message: "subprocess env spread must be wrapped in createExternalProcessEnv",
        });
      }
    }

    expect(formatViolations(violations)).toBe("");
  });

  it("keeps raw child_process calls behind an explicit env boundary", async () => {
    const violations: Violation[] = [];
    const callPattern = new RegExp(`\\b(${rawSubprocessCallNames.join("|")})\\s*\\(`, "g");

    for (const file of await readProductionSourceFiles()) {
      if (file.relativePath === "utils/spawn.ts") {
        continue;
      }

      for (const match of findAll(file.contents, callPattern)) {
        if (!isSubprocessCallMatch(file.contents, match)) {
          continue;
        }

        const openParenIndex = file.contents.indexOf("(", match.index);
        const callBlock = file.contents.slice(
          match.index,
          findCallEnd(file.contents, openParenIndex) + 1,
        );
        if (!/\benv\s*(?::|[,}])/.test(callBlock)) {
          violations.push({
            file: file.relativePath,
            line: lineForIndex(file.contents, match.index),
            message: "subprocess calls must pass an explicit env from the env boundary",
          });
        }
      }
    }

    expect(formatViolations(violations)).toBe("");
  });

  it("passes overlays or specs to spawnProcess and execCommand instead of finalized env", async () => {
    const violations: Violation[] = [];
    const callPattern = new RegExp(`\\b(${safeSubprocessCallNames.join("|")})\\s*\\(`, "g");
    const finalizedBuilderPattern = new RegExp(
      `\\benv\\s*:\\s*(?:${finalizedEnvBuilderNames.join("|")})\\s*\\(`,
    );

    for (const file of await readProductionSourceFiles()) {
      if (file.relativePath === "utils/spawn.ts") {
        continue;
      }

      for (const match of findAll(file.contents, callPattern)) {
        if (!isSubprocessCallMatch(file.contents, match)) {
          continue;
        }

        const openParenIndex = file.contents.indexOf("(", match.index);
        const callBlock = file.contents.slice(
          match.index,
          findCallEnd(file.contents, openParenIndex) + 1,
        );
        if (finalizedBuilderPattern.test(callBlock)) {
          violations.push({
            file: file.relativePath,
            line: lineForIndex(file.contents, match.index),
            message: "pass envOverlay/baseEnv specs so spawn.ts finalizes external env once",
          });
        }
      }
    }

    expect(formatViolations(violations)).toBe("");
  });

  it("does not spread finalized provider env before later overlays", async () => {
    const violations: Violation[] = [];

    for (const file of await readProductionSourceFiles()) {
      const finalizedSpreadPattern = new RegExp(
        `\\.\\.\\.\\s*(?:${finalizedEnvBuilderNames.join("|")})\\s*\\(`,
        "g",
      );
      for (const match of findAll(file.contents, finalizedSpreadPattern)) {
        violations.push({
          file: file.relativePath,
          line: lineForIndex(file.contents, match.index),
          message: "pass overlays into the env boundary so final scrubbing runs last",
        });
      }
    }

    expect(formatViolations(violations)).toBe("");
  });

  it("does not import private or removed env builder APIs outside the env boundary", async () => {
    const privateNamePattern = [...privateEnvBuilderNames, ...removedEnvHelperNames].join("|");
    const importPattern = new RegExp(
      `import\\s*\\{[\\s\\S]*?\\b(?:${privateNamePattern})\\b[\\s\\S]*?\\}\\s*from\\s*["'][^"']*paseo-env\\.js["']`,
      "g",
    );
    const violations: Violation[] = [];

    for (const file of await readProductionSourceFiles()) {
      for (const match of findAll(file.contents, importPattern)) {
        violations.push({
          file: file.relativePath,
          line: lineForIndex(file.contents, match.index),
          message:
            "use createExternalProcessEnv/createExternalCommandProcessEnv or createPaseoInternalEnv at the daemon env boundary",
        });
      }
    }

    expect(formatViolations(violations)).toBe("");
  });

  it("keeps low-level external env builders out of provider files", async () => {
    const importPattern =
      /import\s*\{[\s\S]*?\bcreateExternal(?:Command)?ProcessEnv\b[\s\S]*?\}\s*from\s*["'][^"']*paseo-env\.js["']/g;
    const violations: Violation[] = [];

    for (const file of await readProductionSourceFiles()) {
      if (!file.relativePath.startsWith("server/agent/providers/")) {
        continue;
      }

      for (const match of findAll(file.contents, importPattern)) {
        violations.push({
          file: file.relativePath,
          line: lineForIndex(file.contents, match.index),
          message: "provider files must use provider env specs instead of low-level env builders",
        });
      }
    }

    expect(formatViolations(violations)).toBe("");
  });

  it("only writes PASEO_NODE_ENV from launchers, scripts, tests, or the env boundary", async () => {
    const writerPattern =
      /(?:process\.env\.PASEO_NODE_ENV\s*=|\[\s*PASEO_NODE_ENV\s*\]\s*:|\bPASEO_NODE_ENV\s*[:=]\s*["'](?:development|production|test)["']|PASEO_NODE_ENV=(?:development|production|test))/g;
    const violations: Violation[] = [];

    const files = await readRepositoryTextFiles([
      "packages/server/src",
      "packages/cli/src",
      "packages/desktop/src",
      "packages/desktop/bin",
    ]);
    for (const file of files) {
      if (isPaseoNodeEnvWriterAllowed(file.relativePath)) {
        continue;
      }

      for (const match of findAll(file.contents, writerPattern)) {
        violations.push({
          file: file.relativePath,
          line: lineForIndex(file.contents, match.index),
          message: "PASEO_NODE_ENV may only be set by launchers, scripts, tests, or paseo-env",
        });
      }
    }

    expect(formatViolations(violations)).toBe("");
  });

  it("does not expose daemon env boundary helpers through public server exports", async () => {
    const contents = await readFile(serverExportsPath, "utf8");
    const violations: Violation[] = [];

    for (const match of findAll(
      contents,
      /export\s*\{[\s\S]*\}\s*from\s*["']\.\/paseo-env\.js["']/g,
    )) {
      violations.push({
        file: "server/exports.ts",
        line: lineForIndex(contents, match.index),
        message: "paseo-env helpers must stay private to daemon/server internals",
      });
    }

    for (const match of findAll(
      contents,
      /\b(?:applyProvider(?:Command|ExecPath)?Env|createProviderEnv(?:Spec)?|createExternal(?:Command)?ProcessEnv|createPaseoInternalEnv|resolvePaseoNodeEnv)\b/g,
    )) {
      violations.push({
        file: "server/exports.ts",
        line: lineForIndex(contents, match.index),
        message: "env helpers must stay private to daemon/server internals",
      });
    }

    expect(formatViolations(violations)).toBe("");
  });
});
