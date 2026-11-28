// Bundles @getpaseo/cli into a thin ESM entrypoint plus lazy code-split command chunks.
// Keeps @getpaseo/server/daemon-files bundled for zero-Zod thin RPC startup while leaving
// @getpaseo/server and its heavy subpaths external so daemon spawning and heavy commands
// resolve from the installed @getpaseo/server package.

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const outDir = path.join(packageRoot, "dist");
const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));

const externalServerExceptDaemonFiles = {
  name: "external-server-except-daemon-files",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^@getpaseo\/server(\/.*)?$/ }, (args) => {
      if (args.path === "@getpaseo/server/daemon-files") {
        return null;
      }
      return { path: args.path, external: true };
    });
  },
};

await rm(outDir, { recursive: true, force: true });

await build({
  entryPoints: {
    index: path.join(packageRoot, "src/index.ts"),
  },
  outdir: outDir,
  bundle: true,
  splitting: true,
  format: "esm",
  minify: true,
  platform: "node",
  target: "node22",
  chunkNames: "chunks/[name]-[hash]",
  define: {
    __PASEO_CLI_VERSION__: JSON.stringify(pkg.version),
  },
  external: [
    // Optional native addons probed by `ws` at runtime.
    "bufferutil",
    "utf-8-validate",
  ],
  plugins: [externalServerExceptDaemonFiles],
  // Bundled CommonJS dependencies (`commander`, `ws`) call require() for Node built-ins.
  banner: {
    js: 'import { createRequire as __paseoCliCreateRequire } from "node:module"; const require = __paseoCliCreateRequire(import.meta.url);',
  },
  logLevel: "warning",
});
