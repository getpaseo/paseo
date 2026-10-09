const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { smokePackagedDesktopApp } = require("../e2e/packaged-app-smoke.js");

const EXECUTABLE_NAME = "Paseo";

exports.default = async function afterSign(context) {
  if (context.electronPlatformName === "darwin") {
    const hasOfficialSigning = Boolean(
      process.env.CSC_LINK ||
      process.env.CSC_NAME ||
      process.env.APPLE_API_KEY ||
      process.env.APPLE_ID,
    );
    if (!hasOfficialSigning) {
      const appPath = path.join(context.appOutDir, `${EXECUTABLE_NAME}.app`);
      try {
        // Ensure all nested frameworks and helpers are ad-hoc signed consistently on local builds
        execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
          stdio: "ignore",
        });
      } catch (error) {
        console.warn("Failed to ad-hoc deep sign app bundle:", error);
      }
    }
  }

  if (process.env.PASEO_DESKTOP_SMOKE !== "1") {
    return;
  }

  if (context.electronPlatformName !== "darwin") {
    return;
  }

  await smokePackagedDesktopApp({
    appPath: path.join(context.appOutDir, `${EXECUTABLE_NAME}.app`),
  });
};
