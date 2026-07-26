const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { smokePackagedDesktopApp } = require("./smoke-packaged-desktop-app.js");

const EXECUTABLE_NAME = "Paseo";

function hasSigningTeam(codesignDetails) {
  const match = codesignDetails.match(/^TeamIdentifier=(.+)$/m);
  return Boolean(match?.[1] && match[1] !== "not set");
}

function ensureLaunchableLocalSignature(appPath) {
  const executablePath = path.join(appPath, "Contents", "MacOS", EXECUTABLE_NAME);
  const inspection = spawnSync("codesign", ["-d", "--verbose=4", executablePath], {
    encoding: "utf8",
  });
  const details = `${inspection.stdout ?? ""}\n${inspection.stderr ?? ""}`;
  if (inspection.status === 0 && hasSigningTeam(details)) {
    return;
  }

  const signing = spawnSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--preserve-metadata=identifier,entitlements", appPath],
    { encoding: "utf8" },
  );
  if (signing.status !== 0) {
    throw signing.error ?? new Error(signing.stderr || "Failed to ad-hoc sign local macOS bundle");
  }
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appPath = path.join(context.appOutDir, `${EXECUTABLE_NAME}.app`);
  ensureLaunchableLocalSignature(appPath);

  if (process.env.PASEO_DESKTOP_SMOKE === "1") {
    await smokePackagedDesktopApp({ appPath });
  }
};

exports.hasSigningTeam = hasSigningTeam;
