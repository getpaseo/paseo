#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
// A build must be reproducible from its advertised commit. Untracked artifacts are irrelevant.
if (git("status", "--porcelain", "--untracked-files=no"))
  throw new Error("Commit tracked changes before building Paseo Local.");
const commit = git("rev-parse", "HEAD");
git("fetch", "origin", "refs/heads/paseo-local:refs/remotes/origin/paseo-local");
git("merge-base", "--is-ancestor", "origin/paseo-local", commit);
if (!process.env.PASEO_LOCAL_INSTALL_TARGET && commit !== git("rev-parse", "origin/paseo-local")) {
  throw new Error(
    "Publish this commit to origin/paseo-local before installing it. Use PASEO_LOCAL_INSTALL_TARGET only for isolated verification.",
  );
}
const env = {
  ...process.env,
  PASEO_LOCAL_RELEASE_COMMIT: commit,
  EXPO_PUBLIC_PASEO_BUILD_ID: commit,
};
execFileSync("npm", ["run", "build:desktop:local:bundle"], { cwd: root, env, stdio: "inherit" });

const state =
  process.env.PASEO_LOCAL_BUILDER_HOME ??
  path.join(homedir(), "Library/Application Support/Paseo Local Builder");
function marker(name) {
  if (process.env.PASEO_LOCAL_INSTALL_TARGET) return;
  mkdirSync(state, { recursive: true });
  const file = path.join(state, name);
  writeFileSync(`${file}.tmp`, `${commit}\n`);
  renameSync(`${file}.tmp`, file);
}
marker("last-built-commit");
execFileSync(process.execPath, ["packages/desktop/scripts/install-local-app.mjs"], {
  cwd: root,
  env,
  stdio: "inherit",
});
marker("last-successful-commit");
