import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_MANIFEST_ICON_BYTES, readPluginManifestIcon } from "./manifest-icon.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("readPluginManifestIcon", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function plugin(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-manifest-icon-"));
    roots.push(root);
    const directory = path.join(root, "plugin");
    await mkdir(path.join(directory, "assets"), { recursive: true });
    return directory;
  }

  it("inlines a PNG inside the package as a data URL", async () => {
    const directory = await plugin();
    await writeFile(path.join(directory, "assets", "icon.png"), PNG);

    expect(await readPluginManifestIcon(directory, "assets/icon.png")).toBe(
      `data:image/png;base64,${PNG.toString("base64")}`,
    );
  });

  it("skips a missing file", async () => {
    expect(await readPluginManifestIcon(await plugin(), "assets/icon.png")).toBeUndefined();
  });

  it("skips a file that is not a PNG", async () => {
    const directory = await plugin();
    await writeFile(path.join(directory, "assets", "icon.png"), "<svg />");

    expect(await readPluginManifestIcon(directory, "assets/icon.png")).toBeUndefined();
  });

  it("skips an icon too large to send with every plugin list", async () => {
    const directory = await plugin();
    const large = Buffer.alloc(MAX_MANIFEST_ICON_BYTES + 1);
    PNG.copy(large);
    await writeFile(path.join(directory, "assets", "icon.png"), large);

    expect(await readPluginManifestIcon(directory, "assets/icon.png")).toBeUndefined();
  });

  it("skips a symlink that leaves the package", async () => {
    const directory = await plugin();
    const outside = path.join(path.dirname(directory), "outside.png");
    await writeFile(outside, PNG);
    await symlink(outside, path.join(directory, "assets", "icon.png"));

    expect(await readPluginManifestIcon(directory, "assets/icon.png")).toBeUndefined();
  });

  it("skips a directory", async () => {
    const directory = await plugin();
    await mkdir(path.join(directory, "assets", "icon.png"));

    expect(await readPluginManifestIcon(directory, "assets/icon.png")).toBeUndefined();
  });
});
