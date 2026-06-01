import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const baseUrl = process.env.PASEO_PROFILE_APP_URL ?? "http://localhost:19010";
const serverId = requiredEnv("PASEO_PROFILE_SERVER_ID");
const workspaceId = requiredEnv("PASEO_PROFILE_WORKSPACE_ID");
const agentId = requiredEnv("PASEO_PROFILE_AGENT_ID");
const switchCount = Number(process.env.PASEO_PROFILE_SWITCH_COUNT ?? 6);
const switchWaitMs = Number(process.env.PASEO_PROFILE_SWITCH_WAIT_MS ?? 250);
const idleWaitMs = Number(process.env.PASEO_PROFILE_IDLE_WAIT_MS ?? 0);
const dumpCommits = process.env.PASEO_PROFILE_DUMP_COMMITS === "1";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function createTerminal() {
  const output = execFileSync(
    "npm",
    [
      "run",
      "cli",
      "--",
      "terminal",
      "create",
      "--cwd",
      workspaceId,
      "--name",
      "Tab Switch Profile",
      "--json",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Could not parse terminal create output: ${output}`);
  }
  return JSON.parse(match[0]).id;
}

function killTerminal(terminalId) {
  execFileSync("npm", ["run", "cli", "--", "terminal", "kill", terminalId], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

const createdTerminalId = process.env.PASEO_PROFILE_TERMINAL_ID ? null : createTerminal();
const terminalId = process.env.PASEO_PROFILE_TERMINAL_ID ?? createdTerminalId;
const workspaceSegment = `b64_${Buffer.from(workspaceId, "utf8").toString("base64url")}`;
const workspaceUrl = `${baseUrl}/h/${serverId}/workspace/${workspaceSegment}`;

function tabTestId(kind, id) {
  return `workspace-tab-${kind}_${id}`;
}

function summarize(samples) {
  const byId = new Map();
  for (const sample of samples) {
    const current = byId.get(sample.id) ?? {
      renders: 0,
      actualDuration: 0,
      baseDuration: 0,
    };
    current.renders += 1;
    current.actualDuration += sample.actualDuration;
    current.baseDuration += sample.baseDuration;
    byId.set(sample.id, current);
  }
  return [...byId.entries()]
    .map(([id, value]) => Object.assign({ id }, value))
    .sort((left, right) => right.actualDuration - left.actualDuration);
}

function summarizeCommits(samples) {
  const byCommit = new Map();
  for (const sample of samples) {
    const key = String(sample.commitTime);
    const current = byCommit.get(key) ?? {
      commitTime: sample.commitTime,
      totalActualDuration: 0,
      samples: [],
    };
    current.totalActualDuration += sample.actualDuration;
    current.samples.push({
      id: sample.id,
      actualDuration: sample.actualDuration,
      baseDuration: sample.baseDuration,
    });
    byCommit.set(key, current);
  }

  return [...byCommit.values()].sort((left, right) => left.commitTime - right.commitTime);
}

async function openIntent(page, value) {
  const url = `${workspaceUrl}?renderProfile=1&open=${encodeURIComponent(value)}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByTestId("workspace-tabs-row").waitFor({ timeout: 60_000 });
}

async function clickTab(page, testId) {
  await page.getByTestId(testId).click();
  await page.waitForTimeout(switchWaitMs);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await openIntent(page, `agent:${agentId}`);
    await openIntent(page, `terminal:${terminalId}`);

    const agentTab = tabTestId("agent", agentId);
    const terminalTab = tabTestId("terminal", terminalId);
    await page.getByTestId(agentTab).waitFor({ timeout: 60_000 });
    await page.getByTestId(terminalTab).waitFor({ timeout: 60_000 });

    await clickTab(page, agentTab);
    await clickTab(page, terminalTab);
    await page.waitForTimeout(500);
    await page.evaluate(() => globalThis.__PASEO_RESET_RENDER_PROFILE__?.());

    if (idleWaitMs > 0) {
      await page.waitForTimeout(idleWaitMs);
    }

    for (let index = 0; index < switchCount; index += 1) {
      await clickTab(page, agentTab);
      await clickTab(page, terminalTab);
    }

    const samples = await page.evaluate(() => globalThis.__PASEO_RENDER_PROFILE__ ?? []);
    const reasons = await page.evaluate(() => globalThis.__PASEO_RENDER_PROFILE_REASONS__ ?? {});
    console.log(
      JSON.stringify(
        {
          appUrl: baseUrl,
          serverId,
          workspaceId,
          agentId,
          terminalId,
          switchCount,
          switchWaitMs,
          idleWaitMs,
          samples: samples.length,
          summary: summarize(samples),
          reasons,
          commits: dumpCommits ? summarizeCommits(samples) : undefined,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    if (createdTerminalId) {
      killTerminal(createdTerminalId);
    }
  }
}

await main();
