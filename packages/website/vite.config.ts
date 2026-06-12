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
      const rel = path
        .relative(docsDir, full)
        .replace(/\.md$/, "")
        .replace(/\/index$/, "");
      if (rel === "index" || rel === "") continue;
      routes.add(`/docs/${rel.split(path.sep).join("/")}`);
    }
  };
  walk(docsDir);
  return [...routes].sort();
}

function discoverAgentRoutes(): string[] {
  const routesDir = path.join(__dirname, "src/routes");
  const reserved = new Set([
    "__root",
    "agents",
    "blog",
    "changelog",
    "cloud",
    "docs",
    "download",
    "index",
    "sponsor",
    "privacy",
  ]);
  return fs
    .readdirSync(routesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .map((entry) => entry.name.replace(/\.tsx$/, ""))
    .filter((name) => !reserved.has(name))
    .sort()
    .map((slug) => `/${slug}`);
}

function discoverAlternativeRoutes(): string[] {
  const alternativesDir = path.join(__dirname, "src/routes/alternatives");
  if (!fs.existsSync(alternativesDir)) return [];
  const slugs = fs
    .readdirSync(alternativesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .map((entry) => entry.name.replace(/\.tsx$/, ""))
    .sort();
  return ["/alternatives", ...slugs.map((slug) => `/alternatives/${slug}`)];
}

function discoverBlogRoutes(): string[] {
  const postsDir = path.join(__dirname, "posts");
  if (!fs.existsSync(postsDir)) return ["/blog"];
  const slugs = fs
    .readdirSync(postsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.replace(/\.md$/, ""))
    .sort();
  return ["/blog", ...slugs.map((slug) => `/blog/${slug}`)];
}

const sitemapPages = [
  "/",
  "/agents",
  "/changelog",
  "/cloud",
  "/download",
  "/privacy",
  ...discoverAgentRoutes(),
  ...discoverAlternativeRoutes(),
  ...discoverDocsRoutes(),
  ...discoverBlogRoutes(),
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
      watch: {
        ignored: ["**/.tanstack/**"],
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
