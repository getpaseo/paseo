import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = path.resolve("scripts", "postinstall-patches.mjs");
const bin = path.resolve("node_modules", ".bin");
const packageName = "react-native-draggable-flatlist";

for (const platform of ["ios", "android"]) {
  test(`patched Markdown ships ${platform} props generated from its native specs`, () => {
    const packageDir = path.resolve("packages/app/node_modules/react-native-enriched-markdown");
    const output = mkdtempSync(path.join(tmpdir(), `markdown-${platform}-codegen-`));
    try {
      // includesGeneratedCode makes native builds use the shipped headers instead of
      // regenerating them after patch-package changes the TypeScript specs.
      const result = spawnSync(
        process.execPath,
        [
          path.resolve("node_modules/react-native/scripts/generate-codegen-artifacts.js"),
          "-p",
          packageDir,
          "-t",
          platform,
          "-o",
          output,
          "-s",
          "library",
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const header =
        platform === "ios"
          ? "ReactCodegen/EnrichedMarkdownTextSpec/Props.h"
          : "jni/react/renderer/components/EnrichedMarkdownTextSpec/Props.h";
      assert.equal(
        readFileSync(path.join(packageDir, platform, "generated", header), "utf8"),
        readFileSync(path.join(output, header), "utf8"),
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
}

function createCheckout({ name = packageName, version = "4.0.3", workspace = "" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "postinstall-patches-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "checkout" }));
  const packageDir = path.join(root, workspace, "node_modules", name);
  mkdirSync(packageDir, { recursive: true });
  if (workspace) {
    writeFileSync(path.join(root, workspace, "package.json"), JSON.stringify({ name: "app" }));
  }
  writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name, version }));
  writeFileSync(path.join(packageDir, "index.js"), "export const value = 1;\n");
  mkdirSync(path.join(root, "patches"));
  return { root, packageDir };
}

function writePatch(root, from, to, name = packageName, version = "4.0.3") {
  const file = `node_modules/${name}/index.js`;
  writeFileSync(
    path.join(root, "patches", `${name}+${version}.patch`),
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

test("patches the app-local keyboard controller during install", () => {
  const name = "react-native-keyboard-controller";
  const version = "1.21.12";
  const { root, packageDir } = createCheckout({ name, version, workspace: "packages/app" });
  try {
    writePatch(root, 1, 2, name, version);
    const result = install(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(
      readFileSync(path.join(packageDir, "index.js"), "utf8"),
      "export const value = 2;\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("a missing patch-package fails the install and leaves the package in place", () => {
  const { root, packageDir } = createCheckout();
  try {
    writePatch(root, 1, 2);
    const result = install(root, root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to spawn/);
    assert.equal(existsSync(packageDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
