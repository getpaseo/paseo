import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

const appDir = path.resolve(__dirname, "packages/app");
const appNodeModules = path.resolve(appDir, "node_modules");
const rootNodeModules = path.resolve(__dirname, "node_modules");
const resolvePackageEntry = (packageName: string) => {
  const appPackagePath = path.resolve(appNodeModules, packageName);
  return fs.existsSync(appPackagePath)
    ? appPackagePath
    : path.resolve(rootNodeModules, packageName);
};

export default defineConfig({
  resolve: {
    extensions: [
      ".web.mjs",
      ".web.js",
      ".web.mts",
      ".web.ts",
      ".web.jsx",
      ".web.tsx",
      ".mjs",
      ".js",
      ".mts",
      ".ts",
      ".jsx",
      ".tsx",
      ".json",
    ],
    alias: [
      {
        find: /^@getpaseo\/relay\/e2ee$/,
        replacement: path.resolve(__dirname, "packages/relay/src/e2ee.ts"),
      },
      {
        find: /^@getpaseo\/relay$/,
        replacement: path.resolve(__dirname, "packages/relay/src/index.ts"),
      },
      { find: "@", replacement: path.resolve(appDir, "src") },
      { find: "@server", replacement: path.resolve(__dirname, "packages/server/src") },
      {
        find: "react-native",
        replacement: path.resolve(rootNodeModules, "react-native-web/dist/index.js"),
      },
      { find: "react", replacement: resolvePackageEntry("react") },
      { find: "react-dom", replacement: resolvePackageEntry("react-dom") },
      {
        find: "@xterm/addon-ligatures",
        replacement: path.resolve(appDir, "test-stubs/xterm-addon-ligatures.ts"),
      },
    ],
  },
  test: {
    exclude: ["**/.claude/**"],
  },
});
