const { getDefaultConfig } = require("expo/metro-config");
const { resolve } = require("metro-resolver");
const fs = require("fs");
const path = require("path");

const projectRoot = __dirname;
const appNodeModulesRoot = path.resolve(projectRoot, "node_modules");
const appSrcRoot = path.resolve(projectRoot, "src");
const serverSrcRoot = path.resolve(projectRoot, "../server/src");
const relaySrcRoot = path.resolve(projectRoot, "../relay/src");
const customWebPlatform = (process.env.PASEO_WEB_PLATFORM ?? "")
  .trim()
  .replace(/^\./, "")
  .toLowerCase();

const config = getDefaultConfig(projectRoot);
const defaultResolveRequest = config.resolver.resolveRequest ?? resolve;
const escapedAppSrcRoot = appSrcRoot
  .split(path.sep)
  .map((segment) => segment.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&"))
  .join("[\\\\/]");
const pathSeparatorPattern = "[\\\\/]";

config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  react: path.join(appNodeModulesRoot, "react"),
  "react-dom": path.join(appNodeModulesRoot, "react-dom"),
  "react/jsx-runtime": path.join(appNodeModulesRoot, "react/jsx-runtime"),
  "react/jsx-dev-runtime": path.join(appNodeModulesRoot, "react/jsx-dev-runtime"),
};
config.resolver.blockList = new RegExp(
  `(^${escapedAppSrcRoot}${pathSeparatorPattern}.*\\.(test|spec)\\.(ts|tsx)$|${pathSeparatorPattern}__tests__${pathSeparatorPattern}.*)$`,
);

function isLocalModuleImport(moduleName) {
  return (
    moduleName.startsWith("./") ||
    moduleName.startsWith("../") ||
    moduleName.startsWith("@/") ||
    path.isAbsolute(moduleName)
  );
}

function resolveWithCustomWebOverlay(context, moduleName, platform) {
  const shouldResolveCustomWebVariant =
    platform === "web" &&
    customWebPlatform.length > 0 &&
    customWebPlatform !== "web" &&
    isLocalModuleImport(moduleName);

  if (shouldResolveCustomWebVariant) {
    const overlayContext = {
      ...context,
      // Resolve only "<custom-platform>.<ext>" variants in overlay mode.
      sourceExts: context.sourceExts.map((ext) => `${customWebPlatform}.${ext}`),
      preferNativePlatform: false,
    };

    try {
      return defaultResolveRequest(overlayContext, moduleName, null);
    } catch {
      // Ignore overlay misses and continue with normal web resolution.
    }
  }

  return defaultResolveRequest(context, moduleName, platform);
}

function resolveExpoDomGeneratedSourceImport(context, moduleName) {
  const origin = context.originModulePath;
  if (
    !origin ||
    !origin.endsWith(`${path.sep}node_modules${path.sep}expo${path.sep}dom${path.sep}entry.js`) ||
    !moduleName.startsWith(".")
  ) {
    return null;
  }

  const candidatePath = path.resolve(path.dirname(origin), moduleName);
  if (
    fs.existsSync(candidatePath) &&
    candidatePath.includes(`${path.sep}packages${path.sep}app${path.sep}src${path.sep}`)
  ) {
    return {
      type: "sourceFile",
      filePath: candidatePath,
    };
  }

  return null;
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const origin = context.originModulePath;
  const expoDomGeneratedSourceImport = resolveExpoDomGeneratedSourceImport(context, moduleName);
  if (expoDomGeneratedSourceImport) {
    return expoDomGeneratedSourceImport;
  }

  if (
    origin &&
    (origin.startsWith(serverSrcRoot) || origin.startsWith(relaySrcRoot)) &&
    moduleName.endsWith(".js")
  ) {
    const tsModuleName = moduleName.replace(/\.js$/, ".ts");
    const candidatePath = path.resolve(path.dirname(origin), tsModuleName);
    if (fs.existsSync(candidatePath)) {
      return resolveWithCustomWebOverlay(context, tsModuleName, platform);
    }
  }

  return resolveWithCustomWebOverlay(context, moduleName, platform);
};

module.exports = config;
