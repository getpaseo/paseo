import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

assert.equal(process.platform, "darwin", "Run package verification on macOS");
assert.ok(process.argv[2], "Pass the packaged .app path");
const app = path.resolve(process.argv[2]);
const contents = path.join(app, "Contents");
const info = JSON.parse(
  execFileSync("plutil", ["-convert", "json", "-o", "-", path.join(contents, "Info.plist")]),
);
const executable = path.join(contents, "MacOS", info.CFBundleExecutable);
const frameworks = path.join(contents, "Frameworks");
const libraries = readdirSync(frameworks, { recursive: true })
  .filter((name) => name.endsWith(".dylib"))
  .map((name) => path.join(frameworks, name));

execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
const signature = spawnSync("codesign", ["-dvvv", executable], { encoding: "utf8" });
assert.equal(signature.status, 0, signature.stderr);
if (
  signature.stderr.includes("Signature=adhoc") &&
  /flags=[^\n]*\bruntime\b/.test(signature.stderr) &&
  libraries.length > 0
) {
  const entitlements = execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", executable]);
  assert.ok(entitlements.length > 0, "Ad-hoc app has no library-validation entitlement");
  const values = JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
      input: entitlements,
    }),
  );
  assert.equal(
    values["com.apple.security.cs.disable-library-validation"],
    true,
    "Ad-hoc app cannot satisfy Team ID library validation on a Mac with SIP enabled",
  );
}

function version(value) {
  const parts = value.split(".").map(Number);
  return (parts[0] * 256 + (parts[1] ?? 0)) * 256 + (parts[2] ?? 0);
}

assert.ok(info.LSMinimumSystemVersion, "The app must declare its minimum macOS version");
for (const binary of [executable, ...libraries]) {
  const build = execFileSync("xcrun", ["vtool", "-show-build", binary], { encoding: "utf8" });
  const minima = [...build.matchAll(/\bminos\s+(\d+(?:\.\d+)*)/g)].map((match) => match[1]);
  assert.ok(minima.length > 0, `No macOS deployment target found in ${binary}`);
  for (const minimum of minima) {
    assert.ok(
      version(minimum) <= version(info.LSMinimumSystemVersion),
      `${path.basename(binary)} requires macOS ${minimum}, above the app's ${info.LSMinimumSystemVersion}`,
    );
  }
}

console.log(
  `PASS: bundle signatures, ad-hoc library loading policy, and macOS deployment targets: ${app}`,
);
