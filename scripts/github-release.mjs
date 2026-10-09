import { execFileSync as nodeExecFileSync } from "node:child_process";
import { isMainModule } from "./is-main-module.mjs";

function parseJson(output) {
  return JSON.parse(output);
}

function isNotFoundError(error) {
  return String(error?.stderr ?? "").includes("HTTP 404");
}

export function getGitHubRelease(repo, tag, execFileSync = nodeExecFileSync) {
  try {
    return parseJson(
      execFileSync("gh", ["api", `repos/${repo}/releases/tags/${tag}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    const expectedName = `Paseo ${tag}`;
    const output = execFileSync(
      "gh",
      [
        "api",
        `repos/${repo}/releases?per_page=100`,
        "--jq",
        `[.[] | select(.draft == true and .name == ${JSON.stringify(expectedName)})] | sort_by(.id)`,
      ],
      {
        encoding: "utf8",
      },
    );
    return parseJson(output)[0] ?? null;
  }
}

export function getReleaseLookupTag(release) {
  if (release.draft === true && release.html_url) {
    return new URL(release.html_url).pathname.split("/").at(-1);
  }
  return release.tag_name;
}

function parseArgs(argv) {
  let repo = "";
  let tag = "";
  let cleanupDuplicates = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--repo") {
      repo = argv[index + 1] ?? "";
      index += 1;
    } else if (argv[index] === "--tag") {
      tag = argv[index + 1] ?? "";
      index += 1;
    } else if (argv[index] === "--cleanup-duplicates") {
      cleanupDuplicates = true;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!repo || !tag) {
    throw new Error("Usage: node scripts/github-release.mjs --repo <owner/repo> --tag <tag>");
  }
  return { cleanupDuplicates, repo, tag };
}

if (isMainModule(import.meta.url)) {
  const { cleanupDuplicates, repo, tag } = parseArgs(process.argv.slice(2));
  let release = null;
  for (let attempt = 0; attempt < 5 && !release; attempt += 1) {
    release = getGitHubRelease(repo, tag);
    if (!release && attempt < 4) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    }
  }
  if (!release) {
    process.exitCode = 1;
  } else {
    if (cleanupDuplicates && release.draft === true) {
      const expectedName = `Paseo ${tag}`;
      const duplicateIds = nodeExecFileSync(
        "gh",
        [
          "api",
          `repos/${repo}/releases?per_page=100`,
          "--jq",
          `.[] | select(.draft == true and .name == ${JSON.stringify(expectedName)} and .id != ${release.id}) | .id`,
        ],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const duplicateId of duplicateIds) {
        nodeExecFileSync("gh", [
          "api",
          "--method",
          "DELETE",
          `repos/${repo}/releases/${duplicateId}`,
        ]);
      }
    }
    process.stdout.write(`${getReleaseLookupTag(release)}\n`);
  }
}
