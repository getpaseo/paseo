import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(root, "README.md"), "utf8");

for (const section of [
  "# Paseo + Vercel Sandbox",
  "## Prerequisites",
  "## Install",
  "## Create a session",
  "## Connect from Paseo",
  "## Stop and resume",
  "## Export your work",
  "## Clean up",
  "## Limitations",
]) {
  assert.ok(readme.includes(section), `README missing section: ${section}`);
}

for (const re of [/sk-[a-zA-Z0-9]{20,}/, /ghp_/, /AI_GATEWAY_API_KEY=[A-Za-z0-9]/]) {
  assert.ok(!re.test(readme), `README contains credential-like content: ${re}`);
}

const help = execFileSync("node", [join(root, "dist", "cli.js"), "--help"], { encoding: "utf8" });
for (const cmd of [
  "doctor",
  "create",
  "provision",
  "connect",
  "status",
  "stop",
  "resume",
  "run",
  "diff",
  "export",
  "destroy",
]) {
  assert.ok(help.includes(cmd), `CLI help missing command: ${cmd}`);
}

console.log("PASS docs check");
