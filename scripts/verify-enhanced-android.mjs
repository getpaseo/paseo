import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const apk = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2] && fs.statSync(apk).isFile(), "Pass the local enhanced APK path");
const sdk = process.env.ANDROID_HOME ?? path.join(os.homedir(), "Library/Android/sdk");
const versions = fs
  .readdirSync(path.join(sdk, "build-tools"))
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
const tools = path.join(sdk, "build-tools", versions[0]);
function run(command, args, binary = false) {
  return execFileSync(command, args, {
    encoding: binary ? undefined : "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}
const aapt = path.join(tools, "aapt2");
const badging = run(aapt, ["dump", "badging", apk]);
assert.match(badging, /package: name='sh\.paseo\.enhanced'/);
assert.match(badging, /application-label:'Paseo Enhanced'/);
assert.match(badging, /uses-permission: name='android\.permission\.POST_NOTIFICATIONS'/);
assert.doesNotMatch(badging, /MANAGE_EXTERNAL_STORAGE|application-debuggable/);
const manifest = run(aapt, ["dump", "xmltree", apk, "--file", "AndroidManifest.xml"]);
const lines = manifest.split("\n");
let documentProvider = "";
for (let index = 0; index < lines.length; index++) {
  if (!lines[index].includes("E: provider")) continue;
  const indent = lines[index].search(/\S/);
  let end = index + 1;
  while (end < lines.length) {
    if (lines[end].includes("E:") && lines[end].search(/\S/) <= indent) break;
    end++;
  }
  const block = lines.slice(index, end).join("\n");
  if (block.includes("sh.paseo.enhanced.enhancedfiles")) documentProvider = block;
}
assert.ok(documentProvider, "Enhanced FileProvider must be registered with its own authority");
assert.match(documentProvider, /android:exported[^\n]*=(?:false|\(type 0x12\)0x0)(?:\n|$)/);
assert.match(
  documentProvider,
  /android:grantUriPermissions[^\n]*=(?:true|\(type 0x12\)0xffffffff)(?:\n|$)/,
);
const resources = run(aapt, ["dump", "resources", apk]);
const cachePathsEntry = resources.match(
  /xml\/paseo_document_paths\n\s+\(\) \(file\) (\S+) type=XML/,
);
assert.ok(
  cachePathsEntry,
  "Document cache paths must be packaged (including optimized resource names)",
);
const cachePaths = run(aapt, ["dump", "xmltree", apk, "--file", cachePathsEntry[1]]);
assert.match(cachePaths, /E: cache-path/);
assert.match(cachePaths, /paseo-documents\//);
assert.doesNotMatch(cachePaths, /E: (?:root-path|external-path|files-path)/);
const certificates = run(path.join(tools, "apksigner"), [
  "verify",
  "--verbose",
  "--print-certs",
  apk,
]);
const entries = run("unzip", ["-Z1", apk]).trim().split("\n");
const architectures = [
  ...new Set(
    entries.filter((entry) => entry.startsWith("lib/")).map((entry) => entry.split("/")[1]),
  ),
];
assert.deepEqual(architectures, ["arm64-v8a"]);
const dexFiles = entries.filter((entry) => /^classes\d*\.dex$/.test(entry));
assert.ok(
  dexFiles.some((entry) =>
    run("unzip", ["-p", apk, entry], true).includes(
      Buffer.from("Lsh/paseo/documents/PaseoDocumentsModule;"),
    ),
  ),
  "The native document module must be included in DEX",
);
const bundle = run("unzip", ["-p", apk, "assets/index.android.bundle"], true);
assert.ok(bundle.includes(Buffer.from("PaseoPdf")), "The offline PDF runtime must be bundled");
assert.ok(
  bundle.includes(Buffer.from("This session is in use by another Codex/Paseo process.")),
  "The actionable session import error must be bundled",
);
const configEntry = entries.find((entry) => /(?:^|\/)app\.config$/.test(entry));
assert.ok(configEntry, "Embedded Expo configuration must be present");
const config = JSON.parse(run("unzip", ["-p", apk, configEntry]));
assert.equal(config.android.package, "sh.paseo.enhanced");
assert.equal(config.extra.enhancedBranding, true, "The gold V branding must be enabled");
assert.equal(
  config.extra.enhancedPushConfigured,
  false,
  "This preview intentionally has no remote push credentials",
);
assert.notEqual(config.extra.eas?.projectId, "0e7f65ce-0367-46c8-a238-2b65963d235a");
const sha256 = createHash("sha256").update(fs.readFileSync(apk)).digest("hex");
console.log("Enhanced Android APK checks passed:");
console.log("- independent package, release Hermes bundle, arm64-v8a native libraries");
console.log("- notification permission; no all-files access permission");
console.log(
  "- non-exported FileProvider limited to the document cache; native document module included",
);
console.log("- bundled offline PDF runtime; background push disabled without own credentials");
console.log("- gold V branding enabled; session import conflict feedback bundled");
console.log(
  certificates
    .split("\n")
    .filter((line) =>
      /Verifies|Verified using|certificate DN:|certificate SHA-256 digest:/.test(line),
    )
    .join("\n"),
);
console.log(JSON.stringify({ apk, bytes: fs.statSync(apk).size, sha256 }, null, 2));
console.log("Package inspection does not replace Android UI or Xiaomi device testing.");
