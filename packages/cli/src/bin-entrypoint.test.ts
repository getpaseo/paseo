import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entrypoint = fileURLToPath(new URL("../bin/paseo", import.meta.url));

describe("CLI bin entrypoint", () => {
  it("uses a cross-platform Node shebang", () => {
    const [shebang] = readFileSync(entrypoint, "utf8").split(/\r?\n/u);

    expect(shebang).toBe("#!/usr/bin/env node");
  });
});
