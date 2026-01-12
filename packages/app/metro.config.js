const { getDefaultConfig } = require("expo/metro-config");
const { resolve } = require("metro-resolver");
const fs = require("fs");
const path = require("path");

const projectRoot = __dirname;
const serverSrcRoot = path.resolve(projectRoot, "../server/src");

const config = getDefaultConfig(projectRoot);
const defaultResolveRequest = config.resolver.resolveRequest ?? resolve;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const origin = context.originModulePath;
  if (
    origin &&
    origin.startsWith(serverSrcRoot) &&
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
