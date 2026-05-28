import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { sherpaPlatformPackageName } from "./sherpa-runtime-env.js";

function makeHomeDir(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-sherpa-loader-"));
}

function runtimePackageDir(homeDir: string, packageName: string): string {
  return path.join(homeDir, "runtime", "local-speech", "node_modules", packageName);
}

function writeFileEnsuringDir(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function writeFakeSherpaRuntime(homeDir: string): void {
  const sherpaWasmDir = runtimePackageDir(homeDir, "sherpa-onnx");
  const moduleDir = runtimePackageDir(homeDir, "sherpa-onnx-node");
  const platformDir = runtimePackageDir(homeDir, sherpaPlatformPackageName());
  const onnxCommonDir = runtimePackageDir(homeDir, "onnxruntime-common");
  const onnxNodeDir = runtimePackageDir(homeDir, "onnxruntime-node");

  writeFileEnsuringDir(path.join(sherpaWasmDir, "package.json"), "{}");
  writeFileEnsuringDir(path.join(sherpaWasmDir, "index.js"), "module.exports = {};");
  writeFileEnsuringDir(path.join(sherpaWasmDir, "sherpa-onnx-wasm-nodejs.wasm"), "x");
  writeFileEnsuringDir(
    path.join(moduleDir, "package.json"),
    JSON.stringify({ main: "sherpa-onnx.js" }),
  );
  writeFileEnsuringDir(
    path.join(moduleDir, "sherpa-onnx.js"),
    "module.exports = { OfflineRecognizer: function FakeRecognizer() {} };",
  );
  writeFileEnsuringDir(path.join(moduleDir, "addon.js"), "module.exports = {};");
  writeFileEnsuringDir(path.join(platformDir, "package.json"), "{}");
  writeFileEnsuringDir(path.join(platformDir, "sherpa-onnx.node"), "x");
  writeFileEnsuringDir(path.join(onnxCommonDir, "package.json"), "{}");
  writeFileEnsuringDir(path.join(onnxCommonDir, "dist", "cjs", "index.js"), "module.exports = {};");
  writeFileEnsuringDir(path.join(onnxNodeDir, "package.json"), "{}");
  writeFileEnsuringDir(path.join(onnxNodeDir, "dist", "index.js"), "module.exports = {};");
  writeFileEnsuringDir(
    path.join(
      onnxNodeDir,
      "bin",
      "napi-test",
      process.platform,
      process.arch,
      "onnxruntime_binding.node",
    ),
    "x",
  );
}

describe("sherpa-onnx-node loader", () => {
  afterEach(() => {
    vi.resetModules();
  });

  test("loads sherpa-onnx-node from the PASEO_HOME runtime directory", async () => {
    const homeDir = makeHomeDir();
    writeFakeSherpaRuntime(homeDir);

    const { configureLocalSpeechRuntimeHome, clearLocalSpeechRuntimeHome } =
      await import("../runtime/index.js");
    const { loadSherpaOnnxNode } = await import("./sherpa-onnx-node-loader.js");
    configureLocalSpeechRuntimeHome(homeDir);
    const sherpa = loadSherpaOnnxNode();

    expect(typeof sherpa.OfflineRecognizer).toBe("function");
    clearLocalSpeechRuntimeHome();
  });

  test("throws a structured not-installed error when the runtime is missing", async () => {
    const homeDir = makeHomeDir();

    const { configureLocalSpeechRuntimeHome, clearLocalSpeechRuntimeHome } =
      await import("../runtime/index.js");
    const { loadSherpaOnnxNode } = await import("./sherpa-onnx-node-loader.js");
    configureLocalSpeechRuntimeHome(homeDir);

    expect(() => loadSherpaOnnxNode()).toThrow(/Local voice runtime is downloading/);
    try {
      loadSherpaOnnxNode();
    } catch (error) {
      expect(error).toMatchObject({
        code: "local_speech_runtime_not_installed",
        missingPackageIds: [
          "sherpa-onnx",
          "sherpa-onnx-node",
          "sherpa-platform",
          "onnxruntime-common",
          "onnxruntime-node",
        ],
      });
    }
    clearLocalSpeechRuntimeHome();
  });
});
