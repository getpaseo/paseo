import { rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(process.cwd());
const distPath = resolve(packageRoot, "dist");

if (packageRoot === repoRoot) {
  throw new Error("Refusing to clean dist from the repository root");
}

if (dirname(distPath) !== packageRoot || basename(distPath) !== "dist") {
  throw new Error(`Refusing to clean unexpected path: ${distPath}`);
}

rmSync(distPath, { recursive: true, force: true });
