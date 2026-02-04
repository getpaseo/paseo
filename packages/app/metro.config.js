const { getDefaultConfig } = require("expo/metro-config");
const { resolve } = require("metro-resolver");
const fs = require("fs");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");
const serverSrcRoot = path.resolve(projectRoot, "../server/src");
const relaySrcRoot = path.resolve(projectRoot, "../relay/src");

const config = getDefaultConfig(projectRoot);
const defaultResolveRequest = config.resolver.resolveRequest ?? resolve;

// This app imports TypeScript sources from sibling workspaces (server/relay).
// Metro's default hierarchical lookup won't find hoisted deps when resolving
// from those out-of-tree source files, so point Metro at the monorepo root.
config.watchFolders = Array.from(
  new Set([...(config.watchFolders ?? []), monorepoRoot])
);
config.resolver.nodeModulesPaths = Array.from(
  new Set([
    ...(config.resolver.nodeModulesPaths ?? []),
    path.join(projectRoot, "node_modules"),
    path.join(monorepoRoot, "node_modules"),
  ])
);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const origin = context.originModulePath;
  if (
    origin &&
    (origin.startsWith(serverSrcRoot) || origin.startsWith(relaySrcRoot)) &&
    moduleName.endsWith(".js")
  ) {
    const tsModuleName = moduleName.replace(/\.js$/, ".ts");
    const candidatePath = path.resolve(path.dirname(origin), tsModuleName);
    if (fs.existsSync(candidatePath)) {
      return defaultResolveRequest(context, tsModuleName, platform);
    }
  }

  return defaultResolveRequest(context, moduleName, platform);
};

module.exports = config;
