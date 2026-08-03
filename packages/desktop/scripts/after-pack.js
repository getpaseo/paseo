const fs = require("fs");
const path = require("path");

const { smokePackagedDesktopApp } = require("../e2e/packaged-app-smoke.js");

const EXECUTABLE_NAME = "Paseo";

// electron-builder arch enum → Node.js arch string
const ARCH_MAP = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

const RIPGREP_PLATFORM_DIR = {
  darwin: { arm64: "arm64-darwin", x64: "x64-darwin" },
  linux: { arm64: "arm64-linux", x64: "x64-linux" },
  win32: { arm64: "arm64-win32", x64: "x64-win32" },
};

const PARCEL_WATCHER_PLATFORM_DIRS = {
  darwin: { arm64: ["watcher-darwin-arm64"], x64: ["watcher-darwin-x64"] },
  linux: {
    arm64: ["watcher-linux-arm64-glibc", "watcher-linux-arm64-musl"],
    x64: ["watcher-linux-x64-glibc", "watcher-linux-x64-musl"],
  },
  win32: { arm64: ["watcher-win32-arm64"], x64: ["watcher-win32-x64"] },
};

const SHERPA_PLATFORM_DIR = {
  darwin: { arm64: "sherpa-onnx-darwin-arm64", x64: "sherpa-onnx-darwin-x64" },
  linux: { arm64: "sherpa-onnx-linux-arm64", x64: "sherpa-onnx-linux-x64" },
  win32: { ia32: "sherpa-onnx-win-ia32", x64: "sherpa-onnx-win-x64" },
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

function pruneMatchingChildrenExcept(parent, prefix, keep) {
  if (!fs.existsSync(parent)) return;
  for (const entry of fs.readdirSync(parent)) {
    if (entry.startsWith(prefix) && !keep.has(entry)) {
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

function pruneParcelWatcher(nodeModules, platform, arch) {
  const keep = new Set(PARCEL_WATCHER_PLATFORM_DIRS[platform]?.[arch] || []);
  pruneMatchingChildrenExcept(path.join(nodeModules, "@parcel"), "watcher-", keep);
}

function pruneSherpaOnnx(nodeModules, platform, arch) {
  const keep = new Set(["sherpa-onnx-node"]);
  const platformPackage = SHERPA_PLATFORM_DIR[platform]?.[arch];
  if (platformPackage) keep.add(platformPackage);
  pruneMatchingChildrenExcept(nodeModules, "sherpa-onnx-", keep);
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} is missing from the packaged app: ${filePath}`);
  }
}

function validateWindowsNativeModules(nodeModules, arch) {
  const watcherDir = PARCEL_WATCHER_PLATFORM_DIRS.win32[arch]?.[0];
  if (!watcherDir) {
    throw new Error(`Unsupported Windows architecture for @parcel/watcher: ${arch}`);
  }

  assertFile(
    path.join(nodeModules, "@parcel", watcherDir, "watcher.node"),
    "Parcel watcher binding",
  );
  assertFile(
    path.join(nodeModules, "node-pty", "prebuilds", `win32-${arch}`, "conpty.node"),
    "node-pty binding",
  );

  const sherpaDir = SHERPA_PLATFORM_DIR.win32[arch];
  if (sherpaDir) {
    assertFile(path.join(nodeModules, sherpaDir, "sherpa-onnx.node"), "sherpa-onnx binding");
  }
}

function pruneNativeModules(appOutDir, platform, arch) {
  const resourcesDir =
    platform === "darwin"
      ? path.join(appOutDir, `${EXECUTABLE_NAME}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");

  const nodeModules = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
  if (!fs.existsSync(nodeModules)) {
    if (platform === "win32") {
      throw new Error(`Packaged native modules directory is missing: ${nodeModules}`);
    }
    return;
  }

  const before = dirSizeSync(nodeModules);

  pruneClaudeAgentSdk(nodeModules, platform, arch);
  pruneNodePty(nodeModules, platform, arch);
  pruneSharpLibvips(nodeModules, platform, arch);
  pruneParcelWatcher(nodeModules, platform, arch);
  pruneSherpaOnnx(nodeModules, platform, arch);

  if (platform === "win32") {
    validateWindowsNativeModules(nodeModules, arch);
  }

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

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = ARCH_MAP[context.arch] || process.arch;

  pruneNativeModules(context.appOutDir, platform, arch);

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

exports.pruneNativeModules = pruneNativeModules;
