const childProcess = require("node:child_process");
const path = require("node:path");

const ARCH_MAP = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };
const WORKSPACE_ROOT = path.resolve(__dirname, "../../..");

function getTargetNpmInstallArgs(platform, arch) {
  return [
    "install",
    "--workspaces",
    "--include-workspace-root",
    "--include=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-save",
    "--force",
    `--os=${platform}`,
    `--cpu=${arch}`,
  ];
}

exports.default = function beforePack(context) {
  const platform = context.electronPlatformName;
  if (platform !== "win32") return;

  const arch = ARCH_MAP[context.arch] || process.arch;
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    throw new Error("Cannot install Windows optional dependencies: npm_execpath is unset.");
  }

  console.log(`Installing optional dependencies for ${platform}-${arch}.`);
  childProcess.execFileSync(
    process.execPath,
    [npmExecPath, ...getTargetNpmInstallArgs(platform, arch)],
    {
      cwd: WORKSPACE_ROOT,
      env: process.env,
      stdio: "inherit",
    },
  );
};

exports.getTargetNpmInstallArgs = getTargetNpmInstallArgs;
