const { execFileSync } = require("node:child_process");
const path = require("node:path");

const { smokePackagedDesktopApp } = require("../e2e/packaged-app-smoke.js");
const { verifyMacBundleSignatures } = require("./mac-signature-check");

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  // The product name follows electron-builder.yml, so a rename cannot leave this path behind.
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const signedBuild = Boolean((process.env.CSC_LINK ?? "").trim());
  // Without a certificate electron-builder skips signing; x64 binaries then
  // carry no signature at all, while arm64 only has per-binary linker stamps.
  if (!signedBuild) {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  }
  // Fail the build when the bundle would die at launch with DYLD
  // "different Team IDs" (mixed ad-hoc/Developer ID binaries from a merge or
  // a wrong cert). Local ad-hoc builds pass as long as both sides match.
  verifyMacBundleSignatures({
    appPath,
    executableName: appName,
    expectedTeamId: (process.env.APPLE_TEAM_ID ?? "").trim(),
    signedBuild,
  });

  if (process.env.PASEO_DESKTOP_SMOKE !== "1") {
    return;
  }

  await smokePackagedDesktopApp({ appPath });
};
