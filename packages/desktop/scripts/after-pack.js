const fs = require("fs");
const path = require("path");

const { smokePackagedDesktopApp } = require("./smoke-packaged-desktop-app.js");

const EXECUTABLE_NAME = "Paseo";

// electron-builder arch enum → Node.js arch string
const ARCH_MAP = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

const RIPGREP_PLATFORM_DIR = {
  darwin: { arm64: "arm64-darwin", x64: "x64-darwin" },
  linux: { arm64: "arm64-linux", x64: "x64-linux" },
  win32: { arm64: "arm64-win32", x64: "x64-win32" },
};

const FFF_BIN_PACKAGE = {
  darwin: {
    arm64: ["fff-bin-darwin-arm64"],
    x64: ["fff-bin-darwin-x64"],
    universal: ["fff-bin-darwin-arm64", "fff-bin-darwin-x64"],
  },
  linux: {
    arm64: ["fff-bin-linux-arm64-gnu"],
    x64: ["fff-bin-linux-x64-gnu"],
  },
  win32: {
    arm64: ["fff-bin-win32-arm64"],
    x64: ["fff-bin-win32-x64"],
  },
};

const FFI_RS_PACKAGE = {
  darwin: {
    arm64: ["ffi-rs-darwin-arm64"],
    x64: ["ffi-rs-darwin-x64"],
    universal: ["ffi-rs-darwin-arm64", "ffi-rs-darwin-x64"],
  },
  linux: {
    arm64: ["ffi-rs-linux-arm64-gnu"],
    x64: ["ffi-rs-linux-x64-gnu"],
  },
  win32: {
    arm64: ["ffi-rs-win32-arm64-msvc"],
    x64: ["ffi-rs-win32-x64-msvc"],
  },
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

function keepPackagesForPlatform(packagesByPlatform, platform, arch) {
  return packagesByPlatform[platform]?.[arch] ?? [];
}

function pruneScopedNativePackages(nodeModules, scope, prefix, keepNames) {
  if (keepNames.length === 0) {
    return;
  }

  const scopeDir = path.join(nodeModules, scope);
  if (!fs.existsSync(scopeDir)) {
    return;
  }

  const keep = new Set(keepNames);
  for (const entry of fs.readdirSync(scopeDir)) {
    if (entry.startsWith(prefix) && !keep.has(entry)) {
      rmSafe(path.join(scopeDir, entry));
    }
  }
}

function pruneFffNativePackages(nodeModules, platform, arch) {
  pruneScopedNativePackages(
    nodeModules,
    "@ff-labs",
    "fff-bin-",
    keepPackagesForPlatform(FFF_BIN_PACKAGE, platform, arch),
  );
  pruneScopedNativePackages(
    nodeModules,
    "@yuuang",
    "ffi-rs-",
    keepPackagesForPlatform(FFI_RS_PACKAGE, platform, arch),
  );
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
  pruneFffNativePackages(nodeModules, platform, arch);

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
