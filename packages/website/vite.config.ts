import path from "node:path";
import { defineConfig, type UserConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repoRoot = path.resolve(__dirname, "../..");
const siteHost = "https://paseo.sh";
const sitemapPages = [
  "/",
  "/changelog",
  "/claude-code",
  "/codex",
  "/docs",
  "/download",
  "/opencode",
  "/privacy",
  "/docs/best-practices",
  "/docs/cli",
  "/docs/configuration",
  "/docs/skills",
  "/docs/security",
  "/docs/updates",
  "/docs/voice",
  "/docs/worktrees",
].map((routePath) => ({
  path: routePath,
}));

export default defineConfig((): UserConfig => {
  return {
    server: {
      port: 8082,
      fs: {
        allow: [repoRoot],
      },
    },
    plugins: [
      cloudflare({ viteEnvironment: { name: "ssr" } }),
      tsConfigPaths(),
      tanstackStart({
        router: {
          quoteStyle: "double",
          semicolons: true,
        },
        pages: sitemapPages,
        sitemap: {
          host: siteHost,
        },
      }),
      react(),
      tailwindcss(),
    ],
  };
});
