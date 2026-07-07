#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const oxlint = spawnSync("oxlint", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (oxlint.status !== 0) {
  process.exit(oxlint.status ?? 1);
}

const boundaryArgs = args.filter((arg) => !arg.startsWith("-"));
const boundary = spawnSync("node", ["scripts/check-app-boundaries.mjs", ...boundaryArgs], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(boundary.status ?? 1);
