import { spawnSync, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const target = process.argv[2] ?? "universal";
const architectures = {
  universal: "armeabi-v7a,arm64-v8a,x86,x86_64",
  arm64: "arm64-v8a",
}[target];
if (!architectures) {
  throw new Error(`Unknown APK target: ${target}. Use universal or arm64.`);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const app = path.join(root, "packages/app");
const env = {
  ...process.env,
  APP_VARIANT: "production",
  PASEO_WATCHDOG_BUILD: "1",
  PASEO_DIAGNOSTIC_BUILD_TIME: new Date().toISOString(),
  PASEO_DIAGNOSTIC_REVISION:
    execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim() +
    (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()
      ? "-dirty"
      : ""),
};
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("npm", ["run", "build:app-deps"], root);
run("npx", ["expo", "prebuild", "--platform", "android", "--no-install"], app);
// Gradle does not track Metro's environment flags. Always regenerate the JS artifact
// so a previous ordinary release cannot silently bypass the profiling renderer.
rmSync(path.join(app, "android/app/build/generated/assets"), { recursive: true, force: true });
run(
  "./gradlew",
  [
    "assembleRelease",
    "--no-daemon",
    "--max-workers=2",
    "-Dorg.gradle.parallel=false",
    `-PreactNativeArchitectures=${architectures}`,
  ],
  path.join(app, "android"),
);
const destination = path.join(root, `artifacts/paseo-dogfood-${target}.apk`);
mkdirSync(path.dirname(destination), { recursive: true });
copyFileSync(path.join(app, "android/app/build/outputs/apk/release/app-release.apk"), destination);
console.log(`\nDiagnostic release APK: ${destination}\nLogs: Downloads/Paseo diagnostics\n`);
