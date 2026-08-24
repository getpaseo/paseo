import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

let userDataPath = "";
vi.mock("electron", () => ({ app: { getPath: () => userDataPath } }));

import { deleteLegacySkillSelection, readLegacySkillSelection } from "./legacy-skill-selection";

beforeEach(async () => {
  userDataPath = await mkdtemp(path.join(os.tmpdir(), "paseo-legacy-skills-"));
});

describe("legacy desktop skill selection", () => {
  it("reads and normalizes the legacy preference", async () => {
    await writeFile(
      path.join(userDataPath, "skill-selection.json"),
      JSON.stringify({
        version: 1,
        selection: { mode: "custom", skills: ["paseo-loop", "paseo", "paseo"] },
      }),
    );
    expect(await readLegacySkillSelection()).toEqual({
      mode: "custom",
      skills: ["paseo", "paseo-loop"],
    });
  });

  it("deletes only when the caller confirms daemon persistence", async () => {
    const file = path.join(userDataPath, "skill-selection.json");
    await writeFile(file, JSON.stringify({ version: 1, selection: { mode: "all" } }));
    await expect(readFile(file, "utf8")).resolves.toContain('"mode":"all"');
    await deleteLegacySkillSelection();
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
