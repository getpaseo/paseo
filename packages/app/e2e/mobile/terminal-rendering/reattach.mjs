import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

// Reattaches to a terminal whose PTY has a different size than the app will measure, and checks
// that the client rows equal the daemon's rows. RESIZE=keyboard opens the keyboard, and the
// relaunched app starts with it closed. RESIZE=fold folds an Android foldable emulator and
// relaunches the app unfolded. Either way the shell redraws its prompt on attach.
//
// Preconditions: the app shows terminal TERMINAL_ID, idle at an empty shell prompt, against the
// daemon at PASEO_HOST.
//
//   PLATFORM=android TERMINAL_ID=511fd9f0 PASEO_HOST=localhost:6870 \
//     node e2e/mobile/terminal-rendering/reattach.mjs
//
// The client used to be sized after the replay arrived, so the shell's redraw landed on the
// wrong rows in most trials. TRIALS sets how many reattaches to check.
const platform = process.env.PLATFORM ?? "android";
const appId = process.env.PASEO_TERMINAL_RENDERING_APP_ID ?? "sh.paseo.debug";
const appUrl = process.env.PASEO_TERMINAL_RENDERING_APP_URL;
const terminalId = process.env.TERMINAL_ID;
const host = process.env.PASEO_HOST;
const trials = Number(process.env.TRIALS ?? 5);
const resize = process.env.RESIZE ?? "keyboard";
const label = process.env.PASEO_TERMINAL_RENDERING_LABEL ?? "reattach";
const session = process.env.AGENT_DEVICE_SESSION ?? `terminal-rendering-${platform}`;
const artifacts = resolve(
  process.env.PASEO_TERMINAL_RENDERING_ARTIFACTS ??
    resolve(homedir(), ".paseo/artifacts/terminal-rendering", platform),
  label,
);
const env = {
  ...process.env,
  AGENT_DEVICE_STATE_DIR:
    process.env.AGENT_DEVICE_STATE_DIR ??
    resolve(homedir(), ".paseo/artifacts/terminal-rendering/device-state"),
};
if (!terminalId || !host) throw new Error("Set TERMINAL_ID and PASEO_HOST");
mkdirSync(artifacts, { recursive: true });

function ad(...args) {
  return execFileSync("agent-device", [...args, "--session", session], {
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
}

function paseo(...args) {
  return execFileSync("npm", ["run", "-s", "cli", "--", ...args, "--host", host], {
    cwd: resolve(import.meta.dirname, "../../../../.."),
    encoding: "utf8",
  });
}

function pressControl(id) {
  const node = JSON.parse(ad("snapshot", "-i", "--json")).data.nodes.find(
    (candidate) => candidate.identifier === id,
  );
  if (!node?.rect) throw new Error(`No ${id} control on screen`);
  const { x, y, width, height } = node.rect;
  ad("press", String(Math.round(x + width / 2)), String(Math.round(y + height / 2)));
}

async function resizePty() {
  if (resize === "keyboard") {
    pressControl("terminal-keyboard-toggle");
    await setTimeout(2_000);
    return;
  }
  const adb = (...args) =>
    execFileSync("adb", [
      ...(process.env.ANDROID_SERIAL ? ["-s", process.env.ANDROID_SERIAL] : []),
      ...args,
    ]);
  adb("emu", "fold");
  await setTimeout(5_000);
  adb("shell", "am", "force-stop", appId);
  adb("emu", "unfold");
  await setTimeout(3_000);
}

function clientRows() {
  const nodes = JSON.parse(ad("snapshot", "--json")).data.nodes;
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const rows = [];
  for (const node of nodes) {
    const match = /^terminal-row-(\d+)$/.exec(node.identifier ?? "");
    if (!match) continue;
    // agent-device leaves the label on the parent when the row inherits it.
    const text = node.label ?? (node.inheritsLabel ? byIndex.get(node.parentIndex)?.label : "");
    rows[Number(match[1])] = (text ?? "").trim();
  }
  return rows;
}

/**
 * Waits for the relaunched app to show terminal rows, then for the shell's redraw to land.
 * Returns null when no row appears, for example when the app crashed on launch.
 */
async function attachedClientRows() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await setTimeout(2_000);
    if (clientRows().some((text) => text !== "")) {
      await setTimeout(3_000);
      return clientRows();
    }
  }
  return null;
}

function mismatches(client, server) {
  const rows = [];
  for (let row = 0; row < Math.max(client.length, server.length); row += 1) {
    const expected = (server[row] ?? "").trim();
    const actual = client[row] ?? "";
    if (expected !== actual) rows.push({ row, server: expected, client: actual });
  }
  return rows;
}

const results = [];
for (let trial = 1; trial <= trials; trial += 1) {
  paseo("terminal", "send-keys", terminalId, "clear", "Enter");
  await setTimeout(1_500);
  await resizePty();
  ad("open", appId, ...(appUrl ? [appUrl] : []), "--relaunch");
  const client = await attachedClientRows();
  ad("screenshot", resolve(artifacts, `trial-${trial}.png`));
  if (!client) {
    results.push({ trial, attached: false });
    console.log(`${label} trial ${trial}: no terminal rows appeared`);
    continue;
  }
  const server = paseo("terminal", "capture", terminalId).split("\n");
  const rows = mismatches(client, server);
  results.push({ trial, attached: true, mismatchedRows: rows });
  console.log(`${label} trial ${trial}: ${rows.length} mismatched rows`);
}

writeFileSync(resolve(artifacts, "report.json"), `${JSON.stringify(results, null, 2)}\n`);
const attached = results.filter((result) => result.attached);
const failed = attached.filter((result) => result.mismatchedRows.length > 0).length;
console.log(
  `${label}: ${failed} of ${attached.length} reattaches differ from the daemon, ${trials - attached.length} never attached (${artifacts})`,
);
process.exitCode = failed === 0 && attached.length === trials ? 0 : 1;
