import fs from "node:fs";
import path from "node:path";
import { defineConfig, type UserConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repoRoot = path.resolve(__dirname, "../..");
const siteHost = "https://paseo.sh";

function discoverDocsRoutes(): string[] {
  const docsDir = path.join(repoRoot, "public-docs");
  if (!fs.existsSync(docsDir)) return ["/docs"];
  const routes = new Set<string>(["/docs"]);
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      const rel = path.relative(docsDir, full).replace(/\.md$/, "");
      if (rel === "index") continue;
      routes.add(`/docs/${rel.split(path.sep).join("/")}`);
    }
  };
  walk(docsDir);
  return [...routes].sort();
}

const sitemapPages = [
  "/",
  "/changelog",
  "/claude-code",
  "/cloud",
  "/codex",
  "/download",
  "/opencode",
  "/privacy",
  ...discoverDocsRoutes(),
].map((routePath) => ({
  path: routePath,
}));

export default defineConfig((): UserConfig => {
  return {
    server: {
      host: "0.0.0.0",
      port: 8082,
      strictPort: false,
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
