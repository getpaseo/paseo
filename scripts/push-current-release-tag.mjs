import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main-module.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function usageAndExit(code = 0) {
  process.stderr.write(
    `Usage: node scripts/push-current-release-tag.mjs [--branch <name>] [--check]\n`,
  );
  process.exit(code);
}

function defaultRun(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function defaultRunQuiet(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

function getRemoteRefCommit(ref, runQuiet) {
  try {
    return runQuiet("git", ["ls-remote", "--exit-code", "origin", ref]).split(/\s+/)[0].trim();
  } catch {
    return "";
  }
}

export function getRemoteTagCommit(tag, runQuiet) {
  // Do not pass --refs: it suppresses the peeled `^{}` commit entry for annotated tags.
  return (
    getRemoteRefCommit(`refs/tags/${tag}^{}`, runQuiet) ||
    getRemoteRefCommit(`refs/tags/${tag}`, runQuiet)
  );
}

export function assertReleaseBranch(branchRef) {
  const trimmed = typeof branchRef === "string" ? branchRef.trim() : "";
  if (!trimmed || !trimmed.startsWith("release/") || trimmed === "release/") {
    throw new Error(
      `Refusing to push release from branch "${trimmed || "<detached>"}". ` +
        "Releases must be cut from a release/* branch (for example release/vX.Y.Z or release/vX.Y.Z-beta.N).",
    );
  }
  return trimmed;
}

function parseArgs(argv) {
  const args = {
    branch: "",
    check: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--branch") {
      args.branch = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--check") {
      args.check = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    usageAndExit(1);
  }

  return args;
}

export function pushCurrentReleaseTag(argv = process.argv.slice(2), deps = {}) {
  const cwd = deps.cwd ?? rootDir;
  const run = deps.run ?? ((cmd, args) => defaultRun(cmd, args, cwd));
  const runQuiet = deps.runQuiet ?? ((cmd, args) => defaultRunQuiet(cmd, args, cwd));

  const args = parseArgs(argv);
  const rootPackagePath = path.join(cwd, "package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
  const version = typeof rootPackage.version === "string" ? rootPackage.version.trim() : "";
  if (!version) {
    throw new Error('Root package.json must contain a valid "version"');
  }

  const dirty = runQuiet("git", ["status", "--porcelain"]);
  if (dirty) {
    throw new Error(
      "Git working directory is not clean. Commit and verify changes on the release branch before shipping.",
    );
  }

  const currentBranch = runQuiet("git", ["branch", "--show-current"]);
  const branchRef = assertReleaseBranch(args.branch || currentBranch);
  const headCommit = runQuiet("git", ["rev-parse", "HEAD"]);

  // Require HEAD to match origin/<branchRef> so release:ship never publishes or
  // tags an unpushed commit whose release-branch CI and Desktop Packages have not run.
  const remoteBranchCommit = getRemoteRefCommit(`refs/heads/${branchRef}`, runQuiet);
  if (remoteBranchCommit !== headCommit) {
    throw new Error(
      `HEAD (${headCommit.slice(0, 9)}) does not match origin/${branchRef} (${remoteBranchCommit ? remoteBranchCommit.slice(0, 9) : "not pushed"}). ` +
        `Push ${branchRef} and confirm CI and Desktop Packages pass before shipping.`,
    );
  }

  if (args.check) {
    return { branchRef, headCommit, tag: `v${version}` };
  }

  const tag = `v${version}`;

  let localTagCommit = "";
  try {
    localTagCommit = runQuiet("git", ["rev-list", "-n", "1", tag]);
  } catch {
    run("git", ["tag", "-a", tag, "-m", tag]);
    localTagCommit = runQuiet("git", ["rev-list", "-n", "1", tag]);
  }

  if (localTagCommit !== headCommit) {
    throw new Error(
      `Local tag ${tag} points to ${localTagCommit}, but HEAD is ${headCommit}. ` +
        "Create a new release commit before pushing this tag.",
    );
  }

  const remoteTagCommit = getRemoteTagCommit(tag, runQuiet);

  if (remoteTagCommit) {
    if (remoteTagCommit !== localTagCommit) {
      throw new Error(
        `Remote tag ${tag} points to ${remoteTagCommit}, but local tag points to ${localTagCommit}. ` +
          "Refusing to reuse an existing release tag for a different commit.",
      );
    }
    console.log(`Tag ${tag} already exists on origin at ${localTagCommit.slice(0, 9)}`);
  } else {
    run("git", ["push", "origin", tag]);
  }

  console.log(`Release push complete: branch ${branchRef} and tag ${tag}`);
  return { branchRef, headCommit, tag };
}

if (isMainModule(import.meta.url)) {
  pushCurrentReleaseTag();
}
