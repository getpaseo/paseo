import path from "node:path";

const NODE_MODULES_DIR = "node_modules";

export function getLocalSpeechRuntimeDir(paseoHome: string): string {
  return path.join(paseoHome, "runtime", "local-speech");
}

export function getLocalSpeechRuntimeNodeModulesDir(paseoHome: string): string {
  return path.join(getLocalSpeechRuntimeDir(paseoHome), NODE_MODULES_DIR);
}

export function getLocalSpeechRuntimePackageDir(paseoHome: string, packageName: string): string {
  return path.join(getLocalSpeechRuntimeNodeModulesDir(paseoHome), packageName);
}

export function getLocalSpeechRuntimePackageDirFromRuntimeDir(
  runtimeDir: string,
  packageName: string,
): string {
  return path.join(runtimeDir, NODE_MODULES_DIR, packageName);
}
