import {
  createPaseoDaemon,
  createRootLogger,
} from "../packages/server/dist/server/server/exports.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const testHome = mkdtempSync(path.join(tmpdir(), "paseo-test-home-"));
const testChatsDir = path.join(testHome, "chats");
const testPort = 6799;

console.log("=== 1. Starting test daemon ===");
console.log(`Port: ${testPort}, Home: ${testHome}`);

const logger = createRootLogger({ level: "silent" });
const daemon = await createPaseoDaemon(
  {
    listen: `127.0.0.1:${testPort}`,
    paseoHome: testHome,
    relay: { enabled: false },
    corsAllowedOrigins: ["*"],
    webUi: {
      enabled: true,
      distDir: path.join(REPO_ROOT, "packages", "server", "dist", "server", "web-ui"),
    },
    staticDir: path.join(REPO_ROOT, "packages", "server", "dist", "server", "web-ui"),
  },
  logger,
);
await daemon.start();
console.log(`Daemon successfully listening on port: ${daemon.port}`);

try {
  // 1. Verify Web UI is served
  console.log("\n=== 2. Verifying Web UI bundle is served ===");
  const webRes = await fetch(`http://127.0.0.1:${testPort}/`);
  console.log(`HTTP GET / returned status: ${webRes.status}`);
  const webHtml = await webRes.text();
  console.log(`HTML length: ${webHtml.length} bytes`);
  if (!webHtml.includes("<html") && !webHtml.includes("<!DOCTYPE html>")) {
    throw new Error("Web UI failed to serve HTML");
  }
  console.log("✓ Web UI verification passed!");

  // 2. Test CLI creating chat workspace
  console.log("\n=== 3. Testing CLI workspace create --chat ===");
  const cliPath = path.join(REPO_ROOT, "packages", "cli", "dist", "index.js");
  const { stdout: createOutput } = await execFileAsync(process.execPath, [
    cliPath,
    "workspace",
    "create",
    "--chat",
    "--chats-dir",
    testChatsDir,
    "--title",
    "Local Smoke Test Chat",
    "--host",
    `127.0.0.1:${testPort}`,
    "--json",
  ]);

  const createResult = JSON.parse(createOutput);
  console.log("Workspace ID:", createResult.workspaceId);
  console.log("Workspace Directory (CWD):", createResult.cwd);
  console.log("Workspace Title/Name:", createResult.name);
  console.log("Workspace Isolation:", createResult.isolation);
  console.log("Workspace Project:", createResult.project);
  console.log("✓ CLI workspace create --chat succeeded!");

  // 3. Verify session directory & session.json on disk
  console.log("\n=== 4. Verifying filesystem artifacts ===");
  const chatDir = createResult.cwd;
  if (!existsSync(chatDir)) {
    throw new Error(`Chat directory does not exist: ${chatDir}`);
  }
  console.log(`✓ Chat directory exists: ${chatDir}`);

  const sessionJsonPath = path.join(chatDir, "session.json");
  if (!existsSync(sessionJsonPath)) {
    throw new Error(`session.json does not exist: ${sessionJsonPath}`);
  }
  const sessionData = JSON.parse(readFileSync(sessionJsonPath, "utf8"));
  console.log("✓ session.json exists with content:", JSON.stringify(sessionData));
  if (!sessionData.sessionId || !sessionData.createdAt) {
    throw new Error("session.json is missing required fields");
  }

  // 4. Test CLI listing workspaces
  console.log("\n=== 5. Testing CLI workspace ls ===");
  const { stdout: lsOutput } = await execFileAsync(process.execPath, [
    cliPath,
    "workspace",
    "ls",
    "--host",
    `127.0.0.1:${testPort}`,
    "--json",
  ]);
  const lsResult = JSON.parse(lsOutput);
  console.log(`Listed workspaces count: ${lsResult.length}`);
  const match = lsResult.find((w) => w.workspaceId === createResult.workspaceId);
  if (!match) {
    throw new Error(`Created workspace ${createResult.workspaceId} not found in workspace ls`);
  }
  console.log("Matched workspace in ls:", JSON.stringify(match));
  console.log("✓ Workspace ls verification passed!");

  // 5. Test default directory resolution (without --chats-dir)
  console.log("\n=== 6. Testing default directory generation ===");
  const { stdout: createDefaultOutput } = await execFileAsync(process.execPath, [
    cliPath,
    "workspace",
    "create",
    "--chat",
    "--title",
    "Default Dir Chat",
    "--host",
    `127.0.0.1:${testPort}`,
    "--json",
  ]);
  const defaultResult = JSON.parse(createDefaultOutput);
  console.log(`Default chat dir created: ${defaultResult.cwd}`);
  if (!existsSync(defaultResult.cwd)) {
    throw new Error(`Default chat directory does not exist: ${defaultResult.cwd}`);
  }
  const defaultSessionJson = path.join(defaultResult.cwd, "session.json");
  if (!existsSync(defaultSessionJson)) {
    throw new Error(`default session.json does not exist: ${defaultSessionJson}`);
  }
  console.log("✓ Default directory generation verified!");

  rmSync(defaultResult.cwd, { recursive: true, force: true });
} finally {
  console.log("\n=== 7. Cleaning up test resources ===");
  await daemon.stop();
  rmSync(testHome, { recursive: true, force: true });
  console.log("✓ Test daemon stopped and test directory cleaned up.");
}

console.log("\n🎉 ALL LOCAL SMOKE TESTS PASSED!");
