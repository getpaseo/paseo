import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const appDir = fileURLToPath(new URL(".", import.meta.url));
const rootDir = path.resolve(appDir, "../..");
const require = createRequire(import.meta.url);
const vitestEntry = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");

it.each([
  {
    name: "root",
    cwd: rootDir,
    args: ["packages/app/src/screens/workspace/use-mounted-tab-set.test.ts"],
  },
  {
    name: "app",
    cwd: appDir,
    args: ["--project", "unit", "src/screens/workspace/use-mounted-tab-set.test.ts"],
  },
])(
  "$name tests can render React when the shell exports NODE_ENV=production",
  ({ cwd, args }) => {
    const result = spawnSync(process.execPath, [vitestEntry, "run", ...args], {
      cwd,
      env: { ...process.env, NODE_ENV: "production" },
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  },
  40_000,
);
