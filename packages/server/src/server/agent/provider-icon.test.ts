import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { readConfiguredProviderIcon } from "./provider-icon.js";

test("resolves relative icons within the Paseo home and rejects escaping symlinks", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-icon-"));
  const home = path.join(directory, "home");
  try {
    await mkdir(home);
    vi.stubEnv("PASEO_HOME", home);
    await writeFile(path.join(home, "icon.svg"), "<svg />");
    await writeFile(path.join(directory, "outside.svg"), "<svg />");
    await symlink(path.join(directory, "outside.svg"), path.join(home, "linked.svg"));
    await expect(readConfiguredProviderIcon("icon.svg")).resolves.toBe("<svg />");
    await expect(readConfiguredProviderIcon("linked.svg")).rejects.toThrow(
      "path leaves the Paseo home directory",
    );
    await expect(readConfiguredProviderIcon("../outside.svg")).rejects.toThrow(
      "path leaves the Paseo home directory",
    );
    await expect(readConfiguredProviderIcon(path.join(directory, "outside.svg"))).resolves.toBe(
      "<svg />",
    );
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
