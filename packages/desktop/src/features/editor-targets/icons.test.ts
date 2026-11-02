import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const targetsDirectory = path.resolve(__dirname, "targets");
const iconsDirectory = path.resolve(__dirname, "../../../assets/editor-targets");

describe("editor target icons", () => {
  test("every bundled icon referenced by a target exists", () => {
    const missing: string[] = [];
    for (const file of readdirSync(targetsDirectory).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(path.join(targetsDirectory, file), "utf8");
      for (const match of source.matchAll(/loadIcon\("([^"]+)"\)/g)) {
        if (!existsSync(path.join(iconsDirectory, match[1]))) missing.push(`${file}: ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
