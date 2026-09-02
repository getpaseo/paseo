import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Guard for #3217. babel-preset-expo miscompiles a destructuring-omit whose
// computed key is a *property/element/call access* (it needs a temp):
//   const { [obj.key]: _unused, ...rest } = src
// The preset drops the temp's assignment, so the omit excludes `undefined` and
// removes nothing. Upstream: https://github.com/expo/expo/issues/49231
// Until that lands, keep this shape out of our source — use a plain-identifier
// key, or `const rest = { ...src }; delete rest[obj.key];`.

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "src");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// A computed key that babel lowers through a temp (the shape that breaks).
// Plain identifiers and literals are safe.
function keyNeedsTemp(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) ||
    ts.isElementAccessExpression(expr) ||
    ts.isCallExpression(expr)
  );
}

function findViolations(fileName: string, text: string): number[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectBindingPattern(node) && node.elements.some((e) => e.dotDotDotToken)) {
      for (const el of node.elements) {
        const pn = el.propertyName;
        if (pn && ts.isComputedPropertyName(pn) && keyNeedsTemp(pn.expression)) {
          lines.push(sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

describe("no computed property-access key in a destructuring-omit (#3217)", () => {
  it("detects the dangerous shape (self-check)", () => {
    const bad = `const { [input.draftId]: _removed, ...rest } = state.map;`;
    expect(findViolations("bad.ts", bad)).toHaveLength(1);
    const safe = `const { [draftId]: _removed, ...rest } = state.map;`;
    expect(findViolations("safe.ts", safe)).toHaveLength(0);
  });

  it("is absent from packages/app/src", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_DIR)) {
      const text = readFileSync(file, "utf8");
      // cheap prefilter: needs a rest (`...`) and a computed key that contains a
      // member access (`[ ... . ... ]:`) — the only shape that can trip the bug.
      if (!text.includes("...") || !/\[[^\]\n]*\.[^\]\n]*\]\s*:/.test(text)) continue;
      for (const line of findViolations(file, text)) {
        offenders.push(`${file}:${line}`);
      }
    }
    expect(
      offenders,
      `computed property-access destructuring-omit (miscompiled by babel-preset-expo, #3217):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
