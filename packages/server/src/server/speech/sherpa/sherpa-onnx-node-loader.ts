import { createRequire } from "node:module";
import path from "node:path";

export type SherpaOnnxNodeModule = {
  OfflineRecognizer: new (config: any) => any;
  OnlineRecognizer?: new (config: any) => any;
  OfflineTts?: new (config: any) => any;
};

let cached: SherpaOnnxNodeModule | null = null;

function platformArch(): string {
  const platform = process.platform === "win32" ? "win" : process.platform;
  return `${platform}-${process.arch}`;
}

function prependLibraryPath(envKey: "DYLD_LIBRARY_PATH" | "LD_LIBRARY_PATH", dir: string): void {
  const current = process.env[envKey] ?? "";
  const parts = current.split(":").filter(Boolean);
  if (parts.includes(dir)) {
    return;
  }
  process.env[envKey] = [dir, ...parts].join(":");
}

export function loadSherpaOnnxNode(): SherpaOnnxNodeModule {
  if (cached) {
    return cached;
  }

  const require = createRequire(import.meta.url);

  // sherpa-onnx-node depends on a platform-specific package (e.g. sherpa-onnx-darwin-arm64)
  // that contains the native addon + its shared libraries. On macOS/Linux we need to ensure
  // the appropriate library path env var includes that directory before requiring the addon.
  const arch = platformArch();
  const pkgName = `sherpa-onnx-${arch}`;

  try {
    const pkgJson = require.resolve(`${pkgName}/package.json`);
    const pkgDir = path.dirname(pkgJson);
    if (process.platform === "darwin") {
      prependLibraryPath("DYLD_LIBRARY_PATH", pkgDir);
    } else if (process.platform === "linux") {
      prependLibraryPath("LD_LIBRARY_PATH", pkgDir);
    }
  } catch {
    // Best effort - if the platform package isn't present, require() below will throw a useful error.
  }

  cached = require("sherpa-onnx-node") as SherpaOnnxNodeModule;
  return cached;
}
