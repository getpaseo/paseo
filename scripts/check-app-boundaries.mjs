#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = path.join(repoRoot, "packages/app/src");
const allowlistPath = path.join(repoRoot, "scripts/app-boundaries.allowlist.json");
const allowlist = new Set(JSON.parse(readFileSync(allowlistPath, "utf8")).entries);
const approvedRoots = new Set(["data", "runtime", "contexts"]);
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);
const checks = [
  { name: "client.on", pattern: /\bclient\.on\(/ },
  { name: "getHostRuntimeStore", pattern: /\bgetHostRuntimeStore\(/ },
  { name: "subscribeAll", pattern: /\bsubscribeAll\(/ },
];

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(fullPath);
    }
    return entry.isFile() && sourceExtensions.has(path.extname(entry.name)) ? [fullPath] : [];
  });
}

function normalizePath(filePath) {
  return path.resolve(repoRoot, filePath);
}

function selectedFiles(args) {
  if (args.length === 0) {
    return walk(appSrc);
  }

  return args.flatMap((input) => {
    const fullPath = normalizePath(input);
    if (!existsSync(fullPath)) {
      return [];
    }

    const relative = path.relative(appSrc, fullPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return [];
    }

    const stat = readdirSync(path.dirname(fullPath), { withFileTypes: true }).find(
      (entry) => entry.name === path.basename(fullPath),
    );
    if (stat?.isDirectory()) {
      return walk(fullPath);
    }

    return sourceExtensions.has(path.extname(fullPath)) ? [fullPath] : [];
  });
}

function isApprovedPath(filePath) {
  const relative = path.relative(appSrc, filePath);
  const [firstPart] = relative.split(path.sep);
  return approvedRoots.has(firstPart);
}

function keyFor(relativePath, checkName) {
  return `${relativePath}:${checkName}`;
}

const violations = [];

for (const filePath of selectedFiles(process.argv.slice(2))) {
  if (isApprovedPath(filePath)) {
    continue;
  }

  const relativePath = path.relative(repoRoot, filePath).split(path.sep).join("/");
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const check of checks) {
      if (!check.pattern.test(line)) {
        continue;
      }

      const key = keyFor(relativePath, check.name);
      if (!allowlist.has(key)) {
        violations.push({
          file: relativePath,
          line: index + 1,
          rule: check.name,
          text: line.trim(),
        });
      }
    }
  });
}

if (violations.length > 0) {
  console.error("App boundary check failed.");
  console.error(
    "Move runtime subscriptions/access into packages/app/src/data, src/runtime, or src/contexts.",
  );
  console.error("Existing exceptions live in scripts/app-boundaries.allowlist.json.");
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} ${violation.rule}: ${violation.text}`);
  }
  process.exit(1);
}

console.log("App boundary check passed.");
