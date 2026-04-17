const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const config = require("./metro.config.cjs");

const serverSrcRoot = path.resolve(__dirname, "../server/src");
const relayPackageRoot = path.resolve(__dirname, "../relay");
const relaySrcRoot = path.resolve(__dirname, "../relay/src");
const highlightPackageRoot = path.resolve(__dirname, "../highlight");
const expoTwoWayAudioPackageRoot = path.resolve(__dirname, "../expo-two-way-audio");

test("metro config exposes @server to Metro as a concrete source root", () => {
  assert.equal(config.resolver.extraNodeModules["@server"], serverSrcRoot);
});

test("metro config watches sibling server and relay source trees", () => {
  assert.ok(config.watchFolders.includes(serverSrcRoot));
  assert.ok(config.watchFolders.includes(relaySrcRoot));
});

test("metro config exposes workspace packages through concrete package roots", () => {
  assert.equal(config.resolver.extraNodeModules["@getpaseo/relay"], relayPackageRoot);
  assert.equal(config.resolver.extraNodeModules["@getpaseo/highlight"], highlightPackageRoot);
  assert.equal(
    config.resolver.extraNodeModules["@getpaseo/expo-two-way-audio"],
    expoTwoWayAudioPackageRoot,
  );
});

test("metro config watches sibling workspace package trees used by the app bundle", () => {
  assert.ok(config.watchFolders.includes(relayPackageRoot));
  assert.ok(config.watchFolders.includes(highlightPackageRoot));
  assert.ok(config.watchFolders.includes(expoTwoWayAudioPackageRoot));
});
