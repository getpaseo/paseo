import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import afterPack from "./after-pack.js";
import beforePack from "./before-pack.js";

const temporaryDirs = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createPackagedNodeModules() {
  const appOutDir = mkdtempSync(path.join(tmpdir(), "paseo-native-packaging-"));
  temporaryDirs.push(appOutDir);
  const nodeModules = path.join(appOutDir, "resources", "app.asar.unpacked", "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  return { appOutDir, nodeModules };
}

function touch(root, relativePath) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "native");
}

function addWindowsBindings(nodeModules, arch) {
  touch(nodeModules, `@parcel/watcher-win32-${arch}/watcher.node`);
  touch(nodeModules, `node-pty/prebuilds/win32-${arch}/conpty.node`);
  if (arch === "x64") {
    touch(nodeModules, "sherpa-onnx-win-x64/sherpa-onnx.node");
  }
}

describe("Windows native dependency preparation", () => {
  it.each(["x64", "arm64"])("builds target npm install arguments for %s", (arch) => {
    expect(beforePack.getTargetNpmInstallArgs("win32", arch)).toEqual([
      "install",
      "--workspaces",
      "--include-workspace-root",
      "--include=optional",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--os=win32",
      `--cpu=${arch}`,
    ]);
  });
});

describe("Windows packaged native dependencies", () => {
  it("keeps only Windows x64 watcher, node-pty, and sherpa bindings", () => {
    const { appOutDir, nodeModules } = createPackagedNodeModules();
    addWindowsBindings(nodeModules, "x64");
    touch(nodeModules, "@parcel/watcher-linux-x64-glibc/watcher.node");
    touch(nodeModules, "@parcel/watcher-win32-arm64/watcher.node");
    touch(nodeModules, "node-pty/prebuilds/win32-arm64/conpty.node");
    touch(nodeModules, "sherpa-onnx-linux-x64/sherpa-onnx.node");

    afterPack.pruneNativeModules(appOutDir, "win32", "x64");

    expect(existsSync(path.join(nodeModules, "@parcel/watcher-win32-x64/watcher.node"))).toBe(true);
    expect(existsSync(path.join(nodeModules, "node-pty/prebuilds/win32-x64/conpty.node"))).toBe(
      true,
    );
    expect(existsSync(path.join(nodeModules, "sherpa-onnx-win-x64/sherpa-onnx.node"))).toBe(true);
    expect(existsSync(path.join(nodeModules, "@parcel/watcher-linux-x64-glibc"))).toBe(false);
    expect(existsSync(path.join(nodeModules, "@parcel/watcher-win32-arm64"))).toBe(false);
    expect(existsSync(path.join(nodeModules, "node-pty/prebuilds/win32-arm64"))).toBe(false);
    expect(existsSync(path.join(nodeModules, "sherpa-onnx-linux-x64"))).toBe(false);
  });

  it("keeps Windows ARM64 bindings and removes unsupported sherpa packages", () => {
    const { appOutDir, nodeModules } = createPackagedNodeModules();
    addWindowsBindings(nodeModules, "arm64");
    touch(nodeModules, "@parcel/watcher-win32-x64/watcher.node");
    touch(nodeModules, "node-pty/prebuilds/win32-x64/conpty.node");
    touch(nodeModules, "sherpa-onnx-win-x64/sherpa-onnx.node");

    afterPack.pruneNativeModules(appOutDir, "win32", "arm64");

    expect(existsSync(path.join(nodeModules, "@parcel/watcher-win32-arm64/watcher.node"))).toBe(
      true,
    );
    expect(existsSync(path.join(nodeModules, "node-pty/prebuilds/win32-arm64/conpty.node"))).toBe(
      true,
    );
    expect(existsSync(path.join(nodeModules, "@parcel/watcher-win32-x64"))).toBe(false);
    expect(existsSync(path.join(nodeModules, "node-pty/prebuilds/win32-x64"))).toBe(false);
    expect(existsSync(path.join(nodeModules, "sherpa-onnx-win-x64"))).toBe(false);
  });

  it("fails when the target watcher binding is missing", () => {
    const { appOutDir, nodeModules } = createPackagedNodeModules();
    touch(nodeModules, "node-pty/prebuilds/win32-x64/conpty.node");
    touch(nodeModules, "sherpa-onnx-win-x64/sherpa-onnx.node");

    expect(() => afterPack.pruneNativeModules(appOutDir, "win32", "x64")).toThrow(
      "Parcel watcher binding is missing",
    );
  });

  it("fails when another required target binding is missing", () => {
    const { appOutDir, nodeModules } = createPackagedNodeModules();
    touch(nodeModules, "@parcel/watcher-win32-x64/watcher.node");
    touch(nodeModules, "node-pty/prebuilds/win32-x64/conpty.node");

    expect(() => afterPack.pruneNativeModules(appOutDir, "win32", "x64")).toThrow(
      "sherpa-onnx binding is missing",
    );
  });
});
