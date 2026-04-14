const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const config = require("./metro.config.cjs");

const serverSrcRoot = path.resolve(__dirname, "../server/src");
const relaySrcRoot = path.resolve(__dirname, "../relay/src");

test("metro config exposes @server to Metro as a concrete source root", () => {
  assert.equal(config.resolver.extraNodeModules["@server"], serverSrcRoot);
});

test("metro config watches sibling server and relay source trees", () => {
  assert.ok(config.watchFolders.includes(serverSrcRoot));
  assert.ok(config.watchFolders.includes(relaySrcRoot));
});
