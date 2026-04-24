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
        inline: [
          "zustand",
          "@tanstack/react-query",
          "react-native-web",
          // Force vite to transform lucide; otherwise Node's ESM loader
          // accidentally compiles its `.d.ts` (typings field) and chokes on
          // `import * as react from 'react'` style declarations.
          "lucide-react-native",
        ],
      },
    },
  },
  resolve: {
    alias: [
      {
        find: /^@hubcode\/relay\/e2ee$/,
        replacement: path.resolve(__dirname, "../relay/src/e2ee.ts"),
      },
      {
        find: /^@hubcode\/relay$/,
        replacement: path.resolve(__dirname, "../relay/src/index.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "src") },
      { find: "@server", replacement: path.resolve(__dirname, "../server/src") },
      // Point to the ESM build so Vite can transform its imports and apply the
      // react alias below (the CJS build uses require('react') which bypasses
      // Vite alias resolution). The exact-match form (anchored regex) keeps
      // submodule paths like `react-native-svg` from accidentally hitting
      // this rewrite.
      {
        find: /^react-native$/,
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
      // lucide-react-native's CJS entry require()s `react-native` directly,
      // bypassing Vite's react-native-web alias. Node's ESM loader then
      // hits Flow syntax in react-native/index.js. Tests never render
      // icons, so swap the whole package for a no-op proxy.
      {
        find: /^lucide-react-native$/,
        replacement: path.resolve(__dirname, "test-stubs/lucide-stub.ts"),
      },
    ],
  },
  plugins: [
    // The codebase uses `require("./img.png")` (Metro pattern) for assets.
    // Vitest can't parse PNG bytes as JS — Node throws SyntaxError. Rewrite
    // the source so those requires become an inline stub object that
    // satisfies `<Image source={...} />`.
    {
      name: "stub-png-requires",
      enforce: "pre" as const,
      transform(code: string, id: string) {
        if (id.includes("/node_modules/")) return null;
        if (!/\.(tsx?|jsx?)$/.test(id)) return null;
        if (!/require\(\s*["'][^"']+\.(png|jpe?g|gif|webp|svg)["']\s*\)/.test(code)) {
          return null;
        }
        const stubbed = code.replace(
          /require\(\s*(["'])([^"']+\.(?:png|jpe?g|gif|webp|svg))\1\s*\)/g,
          '({ uri: "stub://$2", width: 0, height: 0 })',
        );
        return { code: stubbed, map: null };
      },
    },
  ],
});
