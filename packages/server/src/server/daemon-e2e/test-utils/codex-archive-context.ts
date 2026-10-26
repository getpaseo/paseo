import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Shared by the deterministic endpoint regression and the live-provider smoke.
// Owns only paths below the caller's temporary root; it never reads credentials.
export function createCodexArchiveContextFixture(root: string) {
  const codexHome = path.join(root, "codex-home");
  const cwd = path.join(root, "project");
  const plugin = path.join(root, "plugin");
  const staticDir = path.join(root, "static");
  for (const directory of [codexHome, cwd, plugin, staticDir]) mkdirSync(directory);
  const launches = path.join(root, "launches.jsonl");
  const wrapper = path.join(root, "wrapper.cjs");
  writeFileSync(
    wrapper,
    `
const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const args = process.argv.slice(2);
const child = spawn("codex", args, { stdio: ["pipe", "inherit", "inherit"], env: process.env });
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (["thread/start", "thread/resume", "thread/read", "thread/archive", "thread/unarchive"].includes(request.method)) {
    const valid = process.env.SESSION_AGENT_ID === process.env.PASEO_AGENT_ID
&& process.env.SESSION_CWD === process.env.PASEO_AGENT_CWD
&& process.env.SESSION_PROVIDER === "context-codex"
&& Boolean(process.env.SESSION_AGENT_ID);
    appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ method: request.method, valid, reason: process.env.SESSION_REASON, purpose: process.env.SESSION_PURPOSE, generation: process.env.SESSION_GENERATION, workspaceId: process.env.SESSION_WORKSPACE_ID, agentId: process.env.SESSION_AGENT_ID, cwd: process.env.SESSION_CWD, provider: process.env.SESSION_PROVIDER, threadId: request.params?.threadId }) + "\\n");
    if (!valid) {
console.error("Missing per-session launch context for " + request.method);
child.kill();
process.exitCode = 42;
return;
    }
  }
  child.stdin.write(line + "\\n");
});
process.stdin.on("end", () => child.stdin.end());
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { console.error("Could not launch codex"); process.exit(1); });
child.on("exit", (code) => process.exit(process.exitCode ?? code ?? 1));
`,
  );
  writeFileSync(
    path.join(plugin, "paseo-plugin.json"),
    JSON.stringify({
      id: "archive-context",
      requirements: { paseo: ">=0.8.0" },
    }),
  );
  writeFileSync(
    path.join(plugin, "index.server.ts"),
    `
import { randomUUID } from "node:crypto";
const generation = randomUUID();
function environment(request, reason, purpose) {
  return { ...request, env: { ...request.env, SESSION_AGENT_ID: request.agentId,
    SESSION_CWD: request.cwd, SESSION_REASON: reason, SESSION_PURPOSE: purpose,
    SESSION_PROVIDER: request.provider, SESSION_WORKSPACE_ID: request.workspaceId,
    SESSION_GENERATION: generation } };
}
export default function contribute(server) {
  server.before("agent.session_open", ({ request }) => {
    if (!["create", "resume", "refresh", "import"].includes(request.reason)
|| !["interactive", "history"].includes(request.purpose)) {
throw new Error("Unexpected session-open reason or purpose");
    }
    return environment(request, request.reason, request.purpose);
  });
  server.before("agent.session_maintenance", ({ request }) =>
    environment(request, request.operation, "maintenance"));
  return () => {};
}
`,
  );
  return { codexHome, cwd, plugin, staticDir, launches, wrapper };
}
