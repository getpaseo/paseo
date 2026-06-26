const fs = require("fs");
const path = require("path");

const { smokePackagedDesktopApp } = require("./smoke-packaged-desktop-app.js");

const EXECUTABLE_NAME = "Paseo";
const WINDOWS_CLI_EXECUTABLE_NAME = "PaseoCli";
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;
const PE_SUBSYSTEM_OFFSET_FROM_PE_HEADER = 0x5c;

// electron-builder arch enum → Node.js arch string
const ARCH_MAP = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

const RIPGREP_PLATFORM_DIR = {
  darwin: { arm64: "arm64-darwin", x64: "x64-darwin" },
  linux: { arm64: "arm64-linux", x64: "x64-linux" },
  win32: { arm64: "arm64-win32", x64: "x64-win32" },
};

function rmSafe(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function pruneChildrenExcept(parent, keep) {
  if (!fs.existsSync(parent)) return;
  for (const entry of fs.readdirSync(parent)) {
    if (!keep.has(entry)) {
      rmSafe(path.join(parent, entry));
    }
  }
}

function pruneClaudeAgentSdk(nodeModules, platform, arch) {
  const vendorRoot = path.join(nodeModules, "@anthropic-ai", "claude-agent-sdk", "vendor");
  const keepName = RIPGREP_PLATFORM_DIR[platform]?.[arch];
  if (keepName) {
    pruneChildrenExcept(path.join(vendorRoot, "ripgrep"), new Set(["COPYING", keepName]));
    pruneChildrenExcept(path.join(vendorRoot, "tree-sitter-bash"), new Set([keepName]));
  }

  // SDK ≥0.2.113 ships per-platform Claude Code binaries via optionalDependencies
  // (~210 MB each). Paseo requires user-installed `claude` on PATH, matching how
  // Codex/OpenCode are integrated, so drop every bundled copy.
  const anthropicDir = path.join(nodeModules, "@anthropic-ai");
  if (fs.existsSync(anthropicDir)) {
    for (const entry of fs.readdirSync(anthropicDir)) {
      if (entry.startsWith("claude-agent-sdk-")) {
        rmSafe(path.join(anthropicDir, entry));
      }
    }
  }
}

function pruneNodePty(nodeModules, platform, arch) {
  const prebuilds = path.join(nodeModules, "node-pty", "prebuilds");
  pruneChildrenExcept(prebuilds, new Set([`${platform}-${arch}`]));

  if (platform !== "win32") {
    rmSafe(path.join(nodeModules, "node-pty", "third_party"));
  }
}

function pruneSharpLibvips(nodeModules, platform, arch) {
  const prefix = `sharp-libvips-${platform}-${arch}`;
  const imgDir = path.join(nodeModules, "@img");
  if (!fs.existsSync(imgDir)) return;

  for (const entry of fs.readdirSync(imgDir)) {
    if (
      entry.startsWith("sharp-") &&
      entry !== prefix &&
      !entry.startsWith(`sharp-${platform}-${arch}`)
    ) {
      rmSafe(path.join(imgDir, entry));
    }
  }
}

function pruneNativeModules(appOutDir, platform, arch) {
  const resourcesDir =
    platform === "darwin"
      ? path.join(appOutDir, `${EXECUTABLE_NAME}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");

  const nodeModules = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
  if (!fs.existsSync(nodeModules)) return;

  const before = dirSizeSync(nodeModules);

  pruneClaudeAgentSdk(nodeModules, platform, arch);
  pruneNodePty(nodeModules, platform, arch);
  pruneSharpLibvips(nodeModules, platform, arch);

  const after = dirSizeSync(nodeModules);
  const savedMB = ((before - after) / 1024 / 1024).toFixed(1);
  console.log(`Pruned native modules: ${savedMB} MB removed (${fmtMB(before)} → ${fmtMB(after)})`);
}

function dirSizeSync(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      try {
        total += fs.statSync(path.join(entry.parentPath || entry.path, entry.name)).size;
      } catch {}
    }
  }
  return total;
}

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setWindowsExecutableSubsystem(filePath, subsystem) {
  const fd = fs.openSync(filePath, "r+");
  try {
    const dosHeader = Buffer.alloc(64);
    fs.readSync(fd, dosHeader, 0, dosHeader.length, 0);
    if (dosHeader.toString("ascii", 0, 2) !== "MZ") {
      throw new Error(`Invalid Windows executable DOS header: ${filePath}`);
    }

    const peHeaderOffset = dosHeader.readUInt32LE(0x3c);
    const peSignature = Buffer.alloc(4);
    fs.readSync(fd, peSignature, 0, peSignature.length, peHeaderOffset);
    if (peSignature.toString("ascii") !== "PE\u0000\u0000") {
      throw new Error(`Invalid Windows executable PE header: ${filePath}`);
    }

    const subsystemOffset = peHeaderOffset + PE_SUBSYSTEM_OFFSET_FROM_PE_HEADER;
    const subsystemBuffer = Buffer.alloc(2);
    subsystemBuffer.writeUInt16LE(subsystem);
    fs.writeSync(fd, subsystemBuffer, 0, subsystemBuffer.length, subsystemOffset);
  } finally {
    fs.closeSync(fd);
  }
}

function createWindowsCliExecutable(appOutDir) {
  const appExecutable = path.join(appOutDir, `${EXECUTABLE_NAME}.exe`);
  const cliExecutable = path.join(appOutDir, `${WINDOWS_CLI_EXECUTABLE_NAME}.exe`);

  fs.copyFileSync(appExecutable, cliExecutable);
  setWindowsExecutableSubsystem(cliExecutable, IMAGE_SUBSYSTEM_WINDOWS_CUI);
  console.log(`Created Windows CLI executable: ${cliExecutable}`);
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = ARCH_MAP[context.arch] || process.arch;

  pruneNativeModules(context.appOutDir, platform, arch);

  if (platform === "win32") {
    createWindowsCliExecutable(context.appOutDir);
  }

  if (platform === "linux" || platform === "win32") {
    if (arch !== process.arch) {
      console.log(
        `Skipping packaged-app smoke: build arch ${arch} differs from host ${process.arch}.`,
      );
    } else {
      await smokeUnpackedAppIfRequested(context.appOutDir);
    }
  }
};

async function smokeUnpackedAppIfRequested(appOutDir) {
  if (process.env.PASEO_DESKTOP_SMOKE !== "1") {
    return;
  }

  await smokePackagedDesktopApp({
    appPath: appOutDir,
  });
}

exports.createWindowsCliExecutable = createWindowsCliExecutable;
exports.setWindowsExecutableSubsystem = setWindowsExecutableSubsystem;
