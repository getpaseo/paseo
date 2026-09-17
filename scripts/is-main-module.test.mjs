import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

test("matches the executed script on this platform", () => {
  const scriptPath = path.resolve("scripts", "github-release.mjs");
  assert.equal(isMainModule(pathToFileURL(scriptPath).href, scriptPath), true);
});

test("does not match when another module is the entry point", () => {
  const scriptPath = path.resolve("scripts", "github-release.mjs");
  const otherPath = path.resolve("scripts", "stamp-rollout.mjs");
  assert.equal(isMainModule(pathToFileURL(scriptPath).href, otherPath), false);
});

test("returns false without an argv entry", () => {
  assert.equal(
    isMainModule(pathToFileURL(path.resolve("scripts", "x.mjs")).href, undefined),
    false,
  );
});

test("the naive string comparison that broke Windows is not used", () => {
  const scriptPath = path.resolve("scripts", "github-release.mjs");
  const url = pathToFileURL(scriptPath).href;
  // On Windows this naive form is `file://D:\\...` and never equals the module URL.
  assert.notEqual(
    `file://${"D:\\a\\paseo\\scripts\\github-release.mjs"}`,
    "file:///D:/a/paseo/scripts/github-release.mjs",
  );
  assert.equal(isMainModule(url, scriptPath), true);
});
