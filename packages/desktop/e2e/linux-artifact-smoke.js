// Observe published Linux artifacts without repairing their sandbox permissions.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { smokePackagedDesktopApp } = require("./packaged-app-smoke.js");

async function main() {
  if (process.getuid() === 0) throw new Error("Launch the smoke as an unprivileged user");
  const release = path.resolve(process.argv[2]);
  const portableSandbox = process.argv[3] === "enabled";
  const artifactRoot = process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR;
  const installedOnly = process.argv.includes("--installed-only");
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-linux-artifacts-"));
  const findArtifact = (suffix) => {
    const matches = fs.readdirSync(release).filter((file) => file.endsWith(suffix));
    if (matches.length !== 1) throw new Error(`Expected one ${suffix} in ${release}: ${matches}`);
    return path.join(release, matches[0]);
  };
  try {
    process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR = path.join(artifactRoot, "installed");
    const helper = fs.statSync("/opt/Paseo/chrome-sandbox");
    if (helper.uid !== 0 || (helper.mode & 0o7777) !== 0o4755) {
      throw new Error("Installed native package did not provide a root-owned 4755 helper");
    }
    await smokePackagedDesktopApp({ appPath: "/opt/Paseo", expectedSandbox: true });
    if (installedOnly) return;

    const appImage = findArtifact(".AppImage");
    fs.chmodSync(appImage, 0o755);
    execFileSync(appImage, ["--appimage-extract"], { cwd: extracted, stdio: "ignore" });
    const appDir = path.join(extracted, "squashfs-root");
    const desktopEntry = fs.readFileSync(path.join(appDir, "Paseo.desktop"), "utf8");
    if (/^Exec=.*--no-sandbox/m.test(desktopEntry)) {
      throw new Error("AppImage desktop entry bypasses runtime sandbox policy");
    }
    process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR = path.join(artifactRoot, "appimage");
    await smokePackagedDesktopApp({
      appPath: appDir,
      executablePath: appImage,
      launchArgs: ["--appimage-extract-and-run"],
      expectedSandbox: portableSandbox,
    });

    const tarDir = path.join(extracted, "tar");
    fs.mkdirSync(tarDir);
    execFileSync("tar", ["-xzf", findArtifact(".tar.gz"), "-C", tarDir]);
    const appPath = fs.existsSync(path.join(tarDir, "Paseo"))
      ? tarDir
      : path.join(tarDir, fs.readdirSync(tarDir)[0]);
    process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR = path.join(artifactRoot, "tar");
    await smokePackagedDesktopApp({ appPath, expectedSandbox: portableSandbox });
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
