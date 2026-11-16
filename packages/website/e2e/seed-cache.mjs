import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const state = process.env.WEBSITE_E2E_PERSIST_PATH;
if (!state) throw new Error("WEBSITE_E2E_PERSIST_PATH is required");
// Keep these local test records fresh for a full test run, even after the normal cache TTL.
const fixtureTimestamp = Date.now() + 24 * 60 * 60 * 1000;
const entries = [
  { key: "github-stars:v1", value: "12.3k" },
  {
    key: "github-release:v2",
    value: {
      stable: {
        version: "0.15.0",
        linuxAppImageAsset: "Paseo-x86_64.AppImage",
        windowsX64Asset: "Paseo-Setup-0.15.0-x64.exe",
        windowsArm64Asset: "Paseo-Setup-0.15.0-arm64.exe",
      },
      beta: null,
    },
  },
];
mkdirSync(state, { recursive: true });
const file = path.join(state, "fixtures.json");
writeFileSync(
  file,
  JSON.stringify(
    entries.map(({ key, value }) => ({
      key,
      value: JSON.stringify({ fetchedAt: fixtureTimestamp, value }),
    })),
  ),
);
execFileSync(
  process.execPath,
  [
    path.join(
      path.dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
      "bin/wrangler.js",
    ),
    "kv",
    "bulk",
    "put",
    file,
    "--binding",
    "WEBSITE_CACHE",
    "--local",
    "--persist-to",
    state,
  ],
  { stdio: "inherit" },
);
