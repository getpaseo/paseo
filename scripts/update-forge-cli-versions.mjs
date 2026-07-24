#!/usr/bin/env node
// Checks gh/glab/tea for new releases and refreshes the pinned version +
// sha256 checksums in packages/server/src/services/forge-cli/forge-cli-versions.json.
// Companion to scripts/update-nix.sh but for the forge CLI auto-installer
// instead of the Nix build hash.
//
// Usage:
//   node scripts/update-forge-cli-versions.mjs
//
// Exits 0 whether or not anything changed -- the caller (CI workflow) diffs
// the file itself to decide whether to commit. One CLI's API being down
// doesn't block updating the other two; failures are logged and skipped.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSIONS_PATH = path.join(
  __dirname,
  "..",
  "packages/server/src/services/forge-cli/forge-cli-versions.json",
);

const ASSET_ARCHES = ["linux_amd64", "linux_arm64"];

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchText(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

// Parses "sha256  filename" lines (two spaces, as gh/glab publish them).
function parseChecksumsFile(text) {
  const byFilename = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (!match) continue;
    byFilename.set(match[2], match[1].toLowerCase());
  }
  return byFilename;
}

function pickLinuxChecksums(byFilename) {
  const picked = {};
  for (const [filename, sha256] of byFilename) {
    if (ASSET_ARCHES.some((arch) => filename.includes(arch))) {
      picked[filename] = sha256;
    }
  }
  return picked;
}

async function updateGh(current) {
  const release = await fetchJson("https://api.github.com/repos/cli/cli/releases/latest", {
    Accept: "application/vnd.github+json",
  });
  const version = release.tag_name.replace(/^v/, "");
  if (version === current?.version) {
    console.log(`gh: up to date (${version})`);
    return current;
  }

  const checksumsAsset = release.assets.find((a) => a.name === `gh_${version}_checksums.txt`);
  if (!checksumsAsset) {
    throw new Error(`gh ${version}: no checksums.txt asset found`);
  }
  const text = await fetchText(checksumsAsset.browser_download_url);
  const checksums = pickLinuxChecksums(parseChecksumsFile(text));

  console.log(`gh: ${current?.version ?? "(none)"} -> ${version}`);
  return { version, checksums };
}

async function updateGlab(current) {
  const release = await fetchJson(
    "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest",
  );
  const version = release.tag_name.replace(/^v/, "");
  if (version === current?.version) {
    console.log(`glab: up to date (${version})`);
    return current;
  }

  const checksumsLink = release.assets.links.find((a) => a.name === "checksums.txt");
  if (!checksumsLink) {
    throw new Error(`glab ${version}: no checksums.txt asset link found`);
  }
  const text = await fetchText(checksumsLink.direct_asset_url);
  const checksums = pickLinuxChecksums(parseChecksumsFile(text));

  console.log(`glab: ${current?.version ?? "(none)"} -> ${version}`);
  return { version, checksums };
}

async function updateTea(current) {
  const release = await fetchJson("https://gitea.com/api/v1/repos/gitea/tea/releases/latest");
  const version = release.tag_name.replace(/^v/, "");
  if (version === current?.version) {
    console.log(`tea: up to date (${version})`);
    return current;
  }

  // Older tea releases only published per-binary ".sha256" sidecars.
  // Current releases (0.14.x+) also publish a combined checksums.txt
  // covering the bare linux binaries directly -- same format as gh/glab,
  // so reuse the same parser instead of the sidecar convention.
  const checksumsAsset = release.assets.find((a) => a.name === "checksums.txt");
  if (!checksumsAsset) {
    throw new Error(`tea ${version}: no checksums.txt asset found`);
  }
  const text = await fetchText(checksumsAsset.browser_download_url);
  const byFilename = parseChecksumsFile(text);
  const checksums = {};
  for (const arch of ["amd64", "arm64"]) {
    const binaryName = `tea-${version}-linux-${arch}`;
    const sha256 = byFilename.get(binaryName);
    if (!sha256) {
      throw new Error(`tea ${version}: no checksum for ${binaryName} in checksums.txt`);
    }
    checksums[binaryName] = sha256;
  }

  console.log(`tea: ${current?.version ?? "(none)"} -> ${version}`);
  return { version, checksums };
}

async function main() {
  const raw = await fs.readFile(VERSIONS_PATH, "utf8");
  const current = JSON.parse(raw);

  const updaters = [
    ["gh", updateGh],
    ["glab", updateGlab],
    ["tea", updateTea],
  ];

  const result = { ...current };
  for (const [cli, updater] of updaters) {
    try {
      result[cli] = await updater(current[cli]);
    } catch (error) {
      console.error(`${cli}: failed to check for updates: ${error.message}`);
    }
  }

  // Preserve stable key ordering so the diff stays minimal.
  const ordered = { gh: result.gh, glab: result.glab, tea: result.tea };
  await fs.writeFile(VERSIONS_PATH, `${JSON.stringify(ordered, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
