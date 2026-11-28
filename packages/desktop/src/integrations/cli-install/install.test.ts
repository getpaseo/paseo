import { mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCliInstallStatus, installCli } from "./install.js";

let directory: string;
const executable = "/Applications/Paseo.app/Contents/MacOS/Paseo";
const shim = "/Applications/Paseo.app/Contents/Resources/bin/paseo";
vi.mock("electron", () => ({ app: { isPackaged: true, getPath: () => executable } }));
vi.mock("electron-log/main", () => ({ default: { info: vi.fn() } }));
vi.mock("./paths.js", () => ({
  getLocalBinDir: () => directory,
  getCliTargetPath: () => path.join(directory, "paseo"),
  getBundledCliShimPath: () => shim,
}));
vi.mock("./shell-rc.js", () => ({ ensurePathInShellRc: async () => ({ shellUpdated: false }) }));

describe.skipIf(process.platform !== "darwin")("packaged macOS CLI installation", () => {
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "paseo-cli-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("offers to reinstall a legacy executable link and replaces it with the shim", async () => {
    const target = path.join(directory, "paseo");
    await symlink(executable, target);
    await expect(getCliInstallStatus()).resolves.toEqual({ installed: false });
    await expect(installCli()).resolves.toEqual({ installed: true });
    await expect(readlink(target)).resolves.toBe(shim);
  });

  it("recognizes an independently managed CLI", async () => {
    await symlink("/opt/homebrew/bin/paseo", path.join(directory, "paseo"));
    await expect(getCliInstallStatus()).resolves.toEqual({ installed: true });
  });
});
