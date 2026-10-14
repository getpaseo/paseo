const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { writeFileSync } = require("node:fs");
const { extractFile } = require("@electron/asar");

const afterPack = require("./after-pack.js").default;

exports.default = async function afterPackLocal(context) {
  await afterPack(context);
  // The installation manifest must be sealed by codesign, not added after signing.
  const resources = path.join(context.appOutDir, "Paseo.app", "Contents", "Resources");
  const metadata = extractFile(path.join(resources, "app.asar"), "dist/local-build.json");
  const { commit } = JSON.parse(metadata.toString());
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("Missing local release identity");
  writeFileSync(path.join(resources, "local-release.json"), metadata);
  execFileSync("/usr/libexec/PlistBuddy", [
    "-c",
    "Delete :CFBundleURLTypes:0",
    path.join(context.appOutDir, "Paseo.app", "Contents", "Info.plist"),
  ]);
};
