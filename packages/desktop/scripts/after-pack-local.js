const { execFileSync } = require("node:child_process");
const path = require("node:path");

const afterPack = require("./after-pack.js").default;

exports.default = async function afterPackLocal(context) {
  await afterPack(context);
  execFileSync("/usr/bin/plutil", [
    "-remove",
    "CFBundleURLTypes",
    path.join(context.appOutDir, "Paseo.app", "Contents", "Info.plist"),
  ]);
};
