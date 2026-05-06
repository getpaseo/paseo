import { getReleaseInfoFromSourceTag } from "./release-version-utils.mjs";

function usageAndExit(code = 1) {
  process.stderr.write(`Usage: node scripts/emit-release-env.mjs --source-tag <tag>\n`);
  process.exit(code);
}

function parseArgs(argv) {
  let sourceTag = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source-tag") {
      sourceTag = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    usageAndExit();
  }

  if (!sourceTag) {
    usageAndExit();
  }

  return sourceTag;
}

const sourceTag = parseArgs(process.argv.slice(2));
const info = getReleaseInfoFromSourceTag(sourceTag);

const entries = [
  ["SOURCE_TAG", info.sourceTag],
  ["RELEASE_TAG", info.releaseTag],
  ["RELEASE_VERSION", info.version],
  ["RELEASE_BASE_VERSION", info.baseVersion],
  ["RELEASE_PRERELEASE", info.prerelease ?? ""],
  ["IS_PRERELEASE", info.isPrerelease ? "true" : "false"],
  ["IS_BETA", info.isBeta ? "true" : "false"],
  ["RELEASE_TYPE", info.releaseType],
  ["RELEASE_CHANNEL", info.releaseChannel],
  ["DESKTOP_VERSION", info.version],
  ["IS_SMOKE_TAG", info.isSmokeTag ? "true" : "false"],
];

for (const [key, value] of entries) {
  process.stdout.write(`${key}=${value}\n`);
}
