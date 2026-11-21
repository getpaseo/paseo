import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main-module.mjs";
import { compareReleaseVersions, parseReleaseVersion } from "./release-version-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

export const PUBLISH_WORKSPACES = [
  "@getpaseo/highlight",
  "@getpaseo/relay",
  "@getpaseo/protocol",
  "@getpaseo/client",
  "@getpaseo/plugin",
  "@getpaseo/server",
  "@getpaseo/cli",
];

const PUBLISH_ATTEMPTS = 4;
const PUBLISH_BACKOFF_MS = 15_000;
const VISIBILITY_ATTEMPTS = 12;
const VISIBILITY_POLL_MS = 5_000;
const VIEW_ATTEMPTS = 3;

function usageAndExit(code = 1) {
  process.stderr.write(
    "Usage: node scripts/publish-release-packages.mjs [--beta] [--dry-run] [--otp <code>]\n",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = { beta: false, dryRun: false, otp: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--beta") {
      args.beta = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--otp") {
      args.otp = argv[index + 1] ?? "";
      if (!args.otp) {
        usageAndExit(1);
      }
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    } else {
      usageAndExit(1);
    }
  }
  return args;
}

export function getNpmStdio({
  interactive = false,
  stdinIsTTY = Boolean(process.stdin.isTTY),
  stdoutIsTTY = Boolean(process.stdout.isTTY),
} = {}) {
  // npm's OTP helper prompts only when both stdin and stdout are TTYs; keep
  // stderr piped so transient registry errors can still be classified for retry.
  if (interactive && stdinIsTTY && stdoutIsTTY) {
    return ["inherit", "inherit", "pipe"];
  }
  return ["ignore", "pipe", "pipe"];
}

function defaultRunNpm(args, options = {}) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: getNpmStdio(options),
  });

  if (result.error) {
    return { status: 1, stdout: "", stderr: result.error.message };
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function outputOf(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function isNotFoundOutput(text) {
  return /\bE404\b|404 Not Found|is not in this registry/i.test(text);
}

function isAlreadyPublishedConflict(text) {
  return /EPUBLISHCONFLICT|cannot publish over the previously published versions/i.test(text);
}

function isTransientNpmError(text) {
  return /\b(E429|E500|E502|E503|E504|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ESOCKETTIMEDOUT|FETCH_ERROR)\b|\b(429|500|502|503|504)\b|socket hang up|network timeout/i.test(
    text,
  );
}

async function isPackageVersionPublished(pkg, version, { runNpm, sleep }) {
  const spec = `${pkg}@${version}`;
  for (let attempt = 1; attempt <= VIEW_ATTEMPTS; attempt += 1) {
    const result = runNpm(["view", spec, "version", "--json"]);
    if (result.status === 0) {
      try {
        const parsed = JSON.parse(result.stdout.trim());
        if (parsed === version || (Array.isArray(parsed) && parsed.includes(version))) {
          return true;
        }
      } catch {
        if (result.stdout.trim() === version) {
          return true;
        }
      }
      return false;
    }

    const combined = outputOf(result);
    if (isNotFoundOutput(combined)) {
      return false;
    }

    if (attempt < VIEW_ATTEMPTS && isTransientNpmError(combined)) {
      await sleep(attempt * 5_000);
      continue;
    }

    throw new Error(`Failed checking whether ${spec} is published:\n${combined}`);
  }
  return false;
}

async function waitForPackageVisibility(pkg, version, { runNpm, sleep }) {
  const spec = `${pkg}@${version}`;
  for (let attempt = 1; attempt <= VISIBILITY_ATTEMPTS; attempt += 1) {
    if (await isPackageVersionPublished(pkg, version, { runNpm, sleep })) {
      return;
    }
    if (attempt < VISIBILITY_ATTEMPTS) {
      console.log(`Waiting for ${spec} to appear on npm (${attempt}/${VISIBILITY_ATTEMPTS})...`);
      await sleep(VISIBILITY_POLL_MS);
    }
  }
  throw new Error(`${spec} did not become visible on npm after ${VISIBILITY_ATTEMPTS} checks.`);
}

async function publishOnePackage(pkg, version, { beta, dryRun, otp }, { runNpm, sleep }) {
  const spec = `${pkg}@${version}`;
  if (!dryRun && (await isPackageVersionPublished(pkg, version, { runNpm, sleep }))) {
    console.log(`Already published ${spec}; skipping.`);
    return;
  }

  const args = ["publish", `--workspace=${pkg}`, "--access", "public"];
  if (beta) {
    args.push("--tag", "beta");
  }
  if (dryRun) {
    args.push("--dry-run");
  }
  if (otp) {
    args.push(`--otp=${otp}`);
  }

  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt += 1) {
    const result = runNpm(args, { interactive: !dryRun });
    if (result.status === 0) {
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (!dryRun) {
        await waitForPackageVisibility(pkg, version, { runNpm, sleep });
      }
      return;
    }

    const combined = outputOf(result);
    if (!dryRun && isAlreadyPublishedConflict(combined)) {
      await waitForPackageVisibility(pkg, version, { runNpm, sleep });
      console.log(`Confirmed ${spec} is published after conflict response.`);
      return;
    }

    if (attempt < PUBLISH_ATTEMPTS && isTransientNpmError(combined)) {
      const delayMs = attempt * PUBLISH_BACKOFF_MS;
      console.warn(
        `Publishing ${spec} failed transiently; retrying in ${delayMs / 1000}s (${attempt + 1}/${PUBLISH_ATTEMPTS})`,
      );
      await sleep(delayMs);
      continue;
    }

    throw new Error(`Failed to publish ${spec}:\n${combined}`);
  }
}

async function syncBetaDistTags(version, { otp }, { runNpm, sleep }) {
  let distTags = {};
  for (let attempt = 1; attempt <= VIEW_ATTEMPTS; attempt += 1) {
    const result = runNpm(["view", "@getpaseo/cli", "dist-tags", "--json"]);
    if (result.status === 0) {
      distTags = JSON.parse(result.stdout.trim());
      break;
    }
    const combined = outputOf(result);
    if (attempt < VIEW_ATTEMPTS && isTransientNpmError(combined)) {
      await sleep(attempt * 5_000);
      continue;
    }
    throw new Error(`Failed to read @getpaseo/cli dist-tags:\n${combined}`);
  }

  const currentBeta = typeof distTags.beta === "string" ? distTags.beta.trim() : "";
  if (currentBeta && compareReleaseVersions(version, currentBeta) <= 0) {
    console.log(`Leaving npm beta dist-tag at ${currentBeta} (newer than or equal to ${version}).`);
    return;
  }

  for (const pkg of PUBLISH_WORKSPACES) {
    const spec = `${pkg}@${version}`;
    const distTagArgs = ["dist-tag", "add", spec, "beta"];
    if (otp) {
      distTagArgs.push(`--otp=${otp}`);
    }
    for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt += 1) {
      const result = runNpm(distTagArgs, { interactive: true });
      if (result.status === 0) {
        break;
      }
      const combined = outputOf(result);
      if (attempt < PUBLISH_ATTEMPTS && isTransientNpmError(combined)) {
        await sleep(attempt * PUBLISH_BACKOFF_MS);
        continue;
      }
      throw new Error(`Failed to move beta dist-tag for ${spec}:\n${combined}`);
    }
  }
  console.log(`Moved npm beta dist-tag to ${version} across all published packages.`);
}

export async function publishReleasePackages(options = {}, deps = {}) {
  const runNpm = deps.runNpm ?? defaultRunNpm;
  const sleep = deps.sleep ?? defaultSleep;
  const beta = Boolean(options.beta);
  const dryRun = Boolean(options.dryRun);
  const otp = typeof options.otp === "string" ? options.otp.trim() : "";
  const version =
    options.version ?? JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version;

  const parsed = parseReleaseVersion(version);
  if (parsed.isPrerelease && !beta) {
    throw new Error(
      `Refusing to publish prerelease version ${version} to latest. Pass --beta instead.`,
    );
  }
  if (!parsed.isPrerelease && beta) {
    throw new Error(
      `Refusing to publish stable version ${version} with --beta. Omit --beta for stable releases.`,
    );
  }

  for (const pkg of PUBLISH_WORKSPACES) {
    await publishOnePackage(pkg, version, { beta, dryRun, otp }, { runNpm, sleep });
  }

  if (!beta && !dryRun) {
    await syncBetaDistTags(version, { otp }, { runNpm, sleep });
  }
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  await publishReleasePackages(args);
}
