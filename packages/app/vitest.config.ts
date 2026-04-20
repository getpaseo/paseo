import { defineConfig, configDefaults } from "vitest/config";
import path from "path";
import fs from "fs";

const appNodeModules = path.resolve(__dirname, "node_modules");
const rootNodeModules = path.resolve(__dirname, "../../node_modules");
const resolvePackageEntry = (packageName: string) => {
  const appPackagePath = path.resolve(appNodeModules, packageName);
  return fs.existsSync(appPackagePath)
    ? appPackagePath
    : path.resolve(rootNodeModules, packageName);
};

export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "e2e/**"],
    setupFiles: [path.resolve(__dirname, "vitest.setup.ts")],
    /**
     * Expo pulls in native tooling (xcode, etc.) that executes files relying on `process.send`.
     * Vitest's default worker pool uses worker_threads, which intentionally stub that API and
     * immediately throw `Unexpected call to process.send`. Running the suite in forked processes
     * keeps `process.send` intact so the app tests can boot before hitting the intentional failures.
     */
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: 2,
      },
    },
    server: {
      deps: {
        fallbackCJS: true,
        inline: ["zustand", "@tanstack/react-query", "react-native-web"],
      },
    },
  },
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
        replacement: path.resolve(__dirname, "../relay/src/e2ee.ts"),
      },
      {
        find: /^@getpaseo\/relay$/,
        replacement: path.resolve(__dirname, "../relay/src/index.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "src") },
      { find: "@server", replacement: path.resolve(__dirname, "../server/src") },
      // Point to the ESM build so Vite can transform its imports and apply the
      // react alias below (the CJS build uses require('react') which bypasses
      // Vite alias resolution).
      {
        find: "react-native",
        replacement: path.resolve(rootNodeModules, "react-native-web/dist/index.js"),
      },
      { find: "react", replacement: resolvePackageEntry("react") },
      {
        find: "react-dom",
        replacement: resolvePackageEntry("react-dom"),
      },
      {
        find: "@xterm/addon-ligatures",
        replacement: path.resolve(__dirname, "test-stubs/xterm-addon-ligatures.ts"),
      },
    ],
  },
});
