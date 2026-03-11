import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "e2e/**"],
    /**
     * Expo pulls in native tooling (xcode, etc.) that executes files relying on `process.send`.
     * Vitest's default worker pool uses worker_threads, which intentionally stub that API and
     * immediately throw `Unexpected call to process.send`. Running the suite in forked processes
     * keeps `process.send` intact so the app tests can boot before hitting the intentional failures.
     */
    pool: "forks",
  },
  resolve: {
    alias: [
      {
        find: "@getpaseo/relay/e2ee",
        replacement: path.resolve(__dirname, "../relay/src/e2ee.ts"),
      },
      {
        find: "@getpaseo/relay",
        replacement: path.resolve(__dirname, "../relay/src/index.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "src") },
      { find: "@server", replacement: path.resolve(__dirname, "../server/src") },
      { find: "react-native", replacement: "react-native-web" },
    ],
  },
});
