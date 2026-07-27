import { defineConfig } from "vitest/config";
import tsConfigPaths from "vite-tsconfig-paths";

// Separate from vite.config.ts on purpose. The Cloudflare plugin rejects the
// `resolve.external` that Vitest sets on the Worker environment, so loading the app
// config here fails before any test runs. These unit tests only need tsconfig path
// resolution (`~/*` and `~android-version-codes`).
export default defineConfig({
  plugins: [tsConfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
