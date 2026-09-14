import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { replaceAppBundle } from "./install-local-app.mjs";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-local-install-"));
  tempDirs.push(root);
  const source = path.join(root, "build", "Paseo.app");
  const target = path.join(root, "Applications", "Paseo Local.app");
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(source, "version"), "new");
  await writeFile(path.join(target, "version"), "old");
  return { source, target };
}

describe("local desktop app installation", () => {
  it("replaces the installed bundle", async () => {
    const { source, target } = await createFixture();
    await mkdir(path.join(source, "Versions", "A"), { recursive: true });
    await symlink("A", path.join(source, "Versions", "Current"));

    await replaceAppBundle({ source, target });

    expect(await readFile(path.join(target, "version"), "utf8")).toBe("new");
    expect(await readlink(path.join(target, "Versions", "Current"))).toBe("A");
  });

  it("restores the installed bundle when activation fails", async () => {
    const { source, target } = await createFixture();
    let renameCount = 0;

    await expect(
      replaceAppBundle({
        source,
        target,
        rename: async (...args) => {
          renameCount += 1;
          if (renameCount === 2) throw new Error("activation failed");
          await rename(...args);
        },
      }),
    ).rejects.toThrow("activation failed");

    expect(await readFile(path.join(target, "version"), "utf8")).toBe("old");
  });
});
