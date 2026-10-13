import assert from "node:assert/strict";
import test from "node:test";

import { collectAssets, uploadWithRetry } from "./upload-release-assets.mjs";

const noSleep = () => Promise.resolve();

test("retries a failing asset and keeps its siblings", async () => {
  const calls = [];
  const exitCodes = { "a.dmg": [1, 1, 0], "b.zip": [0] };

  const exitCode = await uploadWithRetry(
    { release: "rel", files: ["a.dmg", "b.zip"], repo: "getpaseo/paseo" },
    {
      sleep: noSleep,
      upload: ({ file }) => {
        calls.push(file);
        return exitCodes[file].shift();
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ["a.dmg", "a.dmg", "a.dmg", "b.zip"]);
});

test("gives up after the attempt limit and reports failure", async () => {
  let calls = 0;

  const exitCode = await uploadWithRetry(
    { release: "rel", files: ["a.dmg", "b.zip"], repo: "getpaseo/paseo" },
    {
      attempts: 3,
      sleep: noSleep,
      upload: () => {
        calls += 1;
        return 1;
      },
    },
  );

  assert.equal(exitCode, 1);
  // Stops at the first unrecoverable file rather than attempting b.zip.
  assert.equal(calls, 3);
});

test("collects release files and skips manifests", () => {
  const files = collectAssets("/release", {
    readDir: () => ["Paseo.dmg", "beta-mac.yml", "Paseo.zip", "nested"],
    stat: (file) => ({ isFile: () => !file.endsWith("nested") }),
  });

  assert.deepEqual(files, ["/release/Paseo.dmg", "/release/Paseo.zip"]);
});
