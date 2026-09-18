import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "paseo-sandbox-pkg-"));

console.log("packing...");
execSync("npm run build", { cwd: root, stdio: "pipe" });
const packOut = execSync("npm pack --pack-destination " + tmp, { cwd: root, encoding: "utf8" });
const tarball = join(tmp, packOut.trim().split("\n").pop());

console.log("installing into fresh dir...");
const installDir = join(tmp, "install");
execSync(`mkdir -p ${JSON.stringify(installDir)}`);
execFileSync("npm", ["init", "-y"], { cwd: installDir, stdio: "pipe" });
execFileSync("npm", ["install", tarball], { cwd: installDir, stdio: "pipe" });

console.log("checking binary...");
const pkgRoot = join(installDir, "node_modules", "@elisabethrulke", "paseo-vercel-sandbox");
const help = execFileSync("node", [join(pkgRoot, "dist", "cli.js"), "--help"], {
  encoding: "utf8",
});
assert.ok(help.includes("Launch a Paseo daemon"), "help text present");

// seed reads files from the packaged fixture directory; it must ship in the tarball
for (const rel of ["fixture/package.json", "fixture/src/math.mjs", "fixture/test/math.test.mjs"]) {
  assert.ok(statSync(join(pkgRoot, rel)).isFile(), `packaged fixture missing ${rel}`);
}

console.log("scanning for credentials...");
const pkgDir = join(installDir, "node_modules", "@elisabethrulke", "paseo-vercel-sandbox");
const forbidden = [
  /AI_GATEWAY_API_KEY\s*=\s*["'][^"']+["']/,
  /sk-[a-zA-Z0-9]{20,}/,
  /ghp_[a-zA-Z0-9]{20,}/,
];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|ts|mjs|json|md)$/.test(entry) && !entry.endsWith(".map")) {
      const content = readFileSync(p, "utf8");
      for (const re of forbidden) {
        assert.ok(!re.test(content), `forbidden pattern in ${p}`);
      }
    }
  }
}
walk(pkgDir);

console.log("PASS package smoke test");
