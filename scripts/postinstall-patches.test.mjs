import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = path.resolve("scripts", "postinstall-patches.mjs");
const bin = path.resolve("node_modules", ".bin");
const packageName = "react-native-draggable-flatlist";
const patchFile = `${packageName}+4.0.3.patch`;

function createCheckout() {
  const root = mkdtempSync(path.join(tmpdir(), "postinstall-patches-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "checkout" }));
  const packageDir = path.join(root, "node_modules", packageName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version: "4.0.3" }),
  );
  writeFileSync(path.join(packageDir, "index.js"), "export const value = 1;\n");
  mkdirSync(path.join(root, "patches"));
  return { root, packageDir };
}

function writePatch(root, from, to) {
  const file = `node_modules/${packageName}/index.js`;
  writeFileSync(
    path.join(root, "patches", patchFile),
    [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      "@@ -1 +1 @@",
      `-export const value = ${from};`,
      `+export const value = ${to};`,
      "",
    ].join("\n"),
  );
}

function install(root, PATH = `${bin}${path.delimiter}${process.env.PATH}`) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH },
  });
}

// A copy outside the repository cannot resolve patch-package, as in an install without dev
// dependencies.
function installWithoutPatchPackage(root, env = {}) {
  const isolatedScript = path.join(root, "postinstall-patches.mjs");
  copyFileSync(script, isolatedScript);
  return spawnSync(process.execPath, [isolatedScript], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("a patch that changed since it was applied removes the package for a clean reinstall", () => {
  const { root, packageDir } = createCheckout();
  try {
    writePatch(root, 1, 2);
    assert.equal(install(root).status, 0);
    assert.equal(
      readFileSync(path.join(packageDir, "index.js"), "utf8"),
      "export const value = 2;\n",
    );

    writePatch(root, 1, 3);
    const result = install(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Run npm install again/);
    assert.equal(existsSync(packageDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an already applied patch leaves the package in place", () => {
  const { root, packageDir } = createCheckout();
  try {
    writePatch(root, 1, 2);
    assert.equal(install(root).status, 0);
    assert.equal(install(root).status, 0);
    assert.equal(
      readFileSync(path.join(packageDir, "index.js"), "utf8"),
      "export const value = 2;\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patch-package runs without node_modules/.bin on PATH", () => {
  const { root, packageDir } = createCheckout();
  try {
    writePatch(root, 1, 2);
    assert.equal(install(root, root).status, 0);
    assert.equal(
      readFileSync(path.join(packageDir, "index.js"), "utf8"),
      "export const value = 2;\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing patch-package fails the install and leaves the package in place", () => {
  const { root, packageDir } = createCheckout();
  try {
    writePatch(root, 1, 2);
    const result = installWithoutPatchPackage(root, { NODE_ENV: "production" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /installed dependencies require patches/);
    assert.match(result.stderr, /npm ci --include=dev/);
    assert.equal(existsSync(packageDir), true);
    assert.equal(
      readFileSync(path.join(packageDir, "index.js"), "utf8"),
      "export const value = 1;\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing patch-package is fine when no installed package needs a patch", () => {
  const { root, packageDir } = createCheckout();
  try {
    writePatch(root, 1, 2);
    rmSync(packageDir, { recursive: true, force: true });
    const result = installWithoutPatchPackage(root, { NODE_ENV: "production" });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
