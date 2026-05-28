import { readdirSync } from "node:fs";
import path from "node:path";

import { sherpaPlatformPackageName } from "../sherpa/sherpa-runtime-env.js";

const SHERPA_ONNX_VERSION = "1.12.28";
const ONNXRUNTIME_VERSION = "1.24.3";

export type LocalSpeechRuntimePackageId =
  | "sherpa-onnx"
  | "sherpa-onnx-node"
  | "sherpa-platform"
  | "onnxruntime-common"
  | "onnxruntime-node";

export interface LocalSpeechRuntimePackageSpec {
  id: LocalSpeechRuntimePackageId;
  packageName: string;
  version: string;
  requiredFiles: string[];
  validate?: (packageDir: string) => boolean;
}

function hasOnnxruntimeNativeBinding(
  packageDir: string,
  platform: NodeJS.Platform,
  arch: string,
): boolean {
  try {
    const binDir = path.join(packageDir, "bin");
    const napiDirs = readdirSync(binDir).filter((entry) => entry.startsWith("napi-"));
    return napiDirs.some((napiDir) => {
      const archDir = path.join(binDir, napiDir, platform, arch);
      try {
        const files = readdirSync(archDir);
        return files.some((file) => file.endsWith(".node"));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function getLocalSpeechRuntimePackageSpecs(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): LocalSpeechRuntimePackageSpec[] {
  const sherpaPlatformPackage = sherpaPlatformPackageName(platform, arch);
  return [
    {
      id: "sherpa-onnx",
      packageName: "sherpa-onnx",
      version: SHERPA_ONNX_VERSION,
      requiredFiles: ["package.json", "index.js", "sherpa-onnx-wasm-nodejs.wasm"],
    },
    {
      id: "sherpa-onnx-node",
      packageName: "sherpa-onnx-node",
      version: SHERPA_ONNX_VERSION,
      requiredFiles: ["package.json", "sherpa-onnx.js", "addon.js"],
    },
    {
      id: "sherpa-platform",
      packageName: sherpaPlatformPackage,
      version: SHERPA_ONNX_VERSION,
      requiredFiles: ["package.json", "sherpa-onnx.node"],
    },
    {
      id: "onnxruntime-common",
      packageName: "onnxruntime-common",
      version: ONNXRUNTIME_VERSION,
      requiredFiles: ["package.json", "dist/cjs/index.js"],
    },
    {
      id: "onnxruntime-node",
      packageName: "onnxruntime-node",
      version: ONNXRUNTIME_VERSION,
      requiredFiles: ["package.json", "dist/index.js"],
      // onnxruntime-node encodes the N-API version in the native binding path.
      validate: (packageDir) => hasOnnxruntimeNativeBinding(packageDir, platform, arch),
    },
  ];
}
