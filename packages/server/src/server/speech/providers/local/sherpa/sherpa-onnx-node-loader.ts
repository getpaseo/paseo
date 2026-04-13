import { createRequire } from "node:module";
import path from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  applySherpaLoaderEnv,
  resolveSherpaLoaderEnv,
  sherpaPlatformPackageName,
} from "./sherpa-runtime-env.js";

export type SherpaOnnxNodeModule = {
  OfflineRecognizer: new (config: any) => any;
  OnlineRecognizer?: new (config: any) => any;
  OfflineTts?: new (config: any) => any;
  Vad?: new (config: any, bufferSizeInSeconds: number) => any;
  CircularBuffer?: new (capacity: number) => any;
};

let cached: SherpaOnnxNodeModule | null = null;

type LoadAttempt = {
  target: string;
  error: unknown;
};

function appendAttempt(attempts: LoadAttempt[], target: string, error: unknown): void {
  attempts.push({ target, error });
}

function formatError(error: unknown): string {
  if (!error) {
    return "unknown error";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function maybePatchLinuxAddonRunpath(addonPath: string): void {
  if (process.platform !== "linux") {
    return;
  }
  const patchelfCheck = spawnSync("patchelf", ["--version"], {
    stdio: "ignore",
  });
  if (patchelfCheck.status !== 0) {
    return;
  }

  const currentRpath = spawnSync("patchelf", ["--print-rpath", addonPath], {
    encoding: "utf8",
  });
  if (currentRpath.status !== 0) {
    return;
  }
  const rpath = (currentRpath.stdout ?? "").trim();
  if (rpath.includes("$ORIGIN")) {
    return;
  }

  spawnSync("patchelf", ["--set-rpath", "$ORIGIN", addonPath], {
    stdio: "ignore",
  });
}

function loadWithRequire(
  requireFn: NodeRequire,
  target: string,
  attempts: LoadAttempt[],
): SherpaOnnxNodeModule | null {
  try {
    return requireFn(target) as SherpaOnnxNodeModule;
  } catch (error) {
    appendAttempt(attempts, target, error);
    return null;
  }
}

function buildFailure(attempts: LoadAttempt[], pkgName: string): Error {
  const details = attempts
    .map((attempt) => `- ${attempt.target}: ${formatError(attempt.error)}`)
    .join("\n");
  const message = [
    `Failed to load sherpa-onnx-node for ${process.platform}-${process.arch}.`,
    `Node ${process.version} (ABI ${process.versions.modules}).`,
    `Platform package: ${pkgName}.`,
    "Load attempts:",
    details || "- (no attempts made)",
  ].join("\n");
  return new Error(message);
}

export function loadSherpaOnnxNode(): SherpaOnnxNodeModule {
  if (cached) {
    return cached;
  }

  const require = createRequire(import.meta.url);
  const attempts: LoadAttempt[] = [];

  // Pass through upstream support matrix first.
  const direct = loadWithRequire(require, "sherpa-onnx-node", attempts);
  if (direct) {
    cached = direct;
    return cached;
  }

  // sherpa-onnx-node depends on a platform-specific package (e.g. sherpa-onnx-darwin-arm64)
  // that contains the native addon and shared libraries.
  const pkgName = sherpaPlatformPackageName();
  const resolvedEnv = resolveSherpaLoaderEnv();
  const platformPkgDir = resolvedEnv?.libDir ?? null;

  if (platformPkgDir) {
    applySherpaLoaderEnv(process.env);
    const addonPath = path.join(platformPkgDir, "sherpa-onnx.node");

    if (existsSync(addonPath)) {
      const byPath = loadWithRequire(require, addonPath, attempts);
      if (byPath) {
        cached = byPath;
        return cached;
      }

      // Linux fallback for broken prebuilt RUNPATHs.
      maybePatchLinuxAddonRunpath(addonPath);
      const afterPatch = loadWithRequire(require, addonPath, attempts);
      if (afterPatch) {
        cached = afterPatch;
        return cached;
      }
    }
  }

  throw buildFailure(attempts, pkgName);
}
