import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { EDITOR_TARGETS } from "./registry.js";
import type { EditorTargetRuntime } from "./target.js";

const iconsDirectory = path.resolve(__dirname, "../../../assets/editor-targets");

describe("editor target icons", () => {
  test("every target describes itself with its bundled icon files present", async () => {
    const runtime = {
      loadIcon: async (fileName: string) => {
        const bytes = await readFile(path.join(iconsDirectory, fileName));
        return { kind: "image", dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
      },
    } as EditorTargetRuntime;

    const failures: string[] = [];
    for (const target of EDITOR_TARGETS) {
      try {
        await target.describe(runtime);
      } catch (error) {
        failures.push(`${target.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
