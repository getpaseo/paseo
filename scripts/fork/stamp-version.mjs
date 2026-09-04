// Fork-only. Writes one version into the root package.json and every workspace,
// without committing anything.
//
// Upstream commits a version bump before tagging, so its release workflow only has
// to stamp the desktop package. This fork never commits a version bump: the
// committed versions stay identical to upstream so upstream merges never conflict
// on version lines, and the release tag is the only source of the fork's version.
// The desktop app restarts a desktop-managed daemon whenever the two report
// different versions (packages/desktop/src/daemon/daemon-manager.ts), so the
// desktop and server packages must carry the same string in every build.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReleaseVersion } from "../release-version-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");
const rootPackagePath = path.join(rootDir, "package.json");

const raw = process.argv[2] ?? "";
if (!raw) {
  process.stderr.write("Usage: node scripts/fork/stamp-version.mjs <version | vTag>\n");
  process.exit(1);
}

const { version } = parseReleaseVersion(raw.replace(/^v/, ""));

const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
rootPackage.version = version;
writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);

execFileSync("node", [path.join(rootDir, "scripts", "sync-workspace-versions.mjs")], {
  cwd: rootDir,
  stdio: "inherit",
});
