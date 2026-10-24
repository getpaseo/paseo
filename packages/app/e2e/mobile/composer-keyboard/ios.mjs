// Composer autocomplete placement on iOS with the software keyboard: chat, workspace
// draft tab, and New workspace. Run where agent-device reaches the simulator, with the
// development app connected to the fixture host. See docs/mobile-testing.md.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolveAutocompletePlacement } from "./autocomplete-placement.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const env = (name, fallback) => process.env[`PASEO_COMPOSER_KEYBOARD_${name}`] ?? fallback;
const serverId = env("SERVER_ID");
const agentId = env("AGENT_ID");
const workspaceId = env("WORKSPACE_ID");
if (!serverId || !agentId || !workspaceId) {
  throw new Error(
    "Set PASEO_COMPOSER_KEYBOARD_SERVER_ID, _AGENT_ID (an idle chat) and _WORKSPACE_ID (its workspace)",
  );
}
const draftId = env("DRAFT_ID", "composer-keyboard");
const session = env("SESSION", "composer-keyboard-ios");
const device = env("DEVICE", "iPhone 16 Pro");
const artifactsDir = path.join(repoRoot, ".dev/agent-device-artifacts/composer-keyboard-ios");
const grownPrefix = "grown line one\ngrown line two\ngrown line three\n";
// Partial queries with known best matches. `inserted` is the composer text after
// tapping the best match.
const fileCase = { text: "@app", expected: "packages/app", inserted: '"packages/app"' };
// The release skills ship in this repository's .claude/skills.
const skillCase = { text: "/release", expected: "/release-beta", inserted: "/release-beta " };
// The chat fixture's mock provider lists one command.
const chatCommandCase = { text: "/mo", expected: "/mock", inserted: "/mock " };

fs.mkdirSync(artifactsDir, { recursive: true });

function ad(...args) {
  return execFileSync("agent-device", [...args, "--session", session], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function snapshot(name) {
  const output = ad("snapshot", "--raw", "--json");
  fs.writeFileSync(path.join(artifactsDir, `${name}.json`), output);
  ad("screenshot", path.join(artifactsDir, `${name}.png`));
  return JSON.parse(output);
}

const nodeById = (snap, id) => snap.data.nodes.find((node) => node.identifier === id && node.rect);
const keyboardShown = (snap) => snap.data.nodes.some((node) => node.type === "Keyboard");
const composerText = (snap) =>
  snap.data.nodes.find((node) => node.type === "TextView" && node.rect)?.value ?? "";

async function waitFor(name, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = snapshot(name);
    if (predicate(snap)) return snap;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${name}`);
    await sleep(500);
  }
}

// Keyboard motion has settled once two snapshots agree on the composer position.
async function settledPlacement(name, keyboard) {
  let previousTop;
  return waitFor(name, (snap) => {
    const composer = nodeById(snap, "message-input-root");
    if (!nodeById(snap, "composer-autocomplete-popover") || !composer) return false;
    if (keyboardShown(snap) !== keyboard) return false;
    const stable = composer.rect.y === previousTop;
    previousTop = composer.rect.y;
    return stable;
  });
}

function assertPlacement(name, snap, expected) {
  const placement = resolveAutocompletePlacement(snap, { expected });
  process.stdout.write(
    `PASS ${name}: popover ${Math.round(placement.popover.y)}-${Math.round(
      placement.popover.y + placement.popover.height,
    )} above composer ${Math.round(placement.composer.y)}, ${expected} drawn\n`,
  );
  return placement;
}

// iOS has no generic keyboard dismissal. Tapping the chat stream dismisses it; a
// draft has no stream, so open and close the model sheet, which takes input focus.
async function dismissKeyboard(snap) {
  const composer = nodeById(snap, "message-input-root").rect;
  ad("press", "4", String(Math.round(composer.y - 8)));
  await sleep(1_000);
  if (!keyboardShown(snapshot("dismiss-keyboard"))) return;
  const sheetOpen = (sheet) =>
    sheet.data.nodes.some((node) => node.type === "Button" && node.label === "Close");
  ad("press", 'id="combined-model-selector"');
  await waitFor("dismiss-keyboard-sheet", sheetOpen);
  ad("press", 'label="Close"');
  // The input is not hittable until the sheet has gone.
  await waitFor("dismiss-keyboard-done", (done) => !sheetOpen(done) && !keyboardShown(done));
}

// Tap past the end of the (short) last line so the caret lands after the mention.
// The input's right padding holds the fullscreen toggle; stay clear of it.
function focusAtEnd(snap) {
  const input = snap.data.nodes.find((node) => node.type === "TextView" && node.rect)?.rect;
  if (!input) throw new Error("Missing composer input");
  ad(
    "press",
    String(Math.round(input.x + input.width * 0.7)),
    String(Math.round(input.y + input.height - 6)),
  );
}

// `fill` cannot replace a multi-line draft or write an empty one, so delete from the end.
async function clearInput(name) {
  focusAtEnd(snapshot(`${name}-before-clear`));
  const keyboard = await waitFor(`${name}-clear`, keyboardShown);
  const deleteKey = keyboard.data.nodes.find(
    (node) => node.type === "Key" && node.label === "delete" && node.rect,
  )?.rect;
  if (!deleteKey) throw new Error("Missing keyboard delete key");
  const length = composerText(keyboard).length;
  ad(
    "press",
    String(Math.round(deleteKey.x + deleteKey.width / 2)),
    String(Math.round(deleteKey.y + deleteKey.height / 2)),
    "--count",
    String(length + 2),
    "--interval-ms",
    "40",
  );
}

// The accessibility value drops a trailing space.
const sameText = (actual, expected) => actual.trimEnd() === expected.trimEnd();

async function runCase(host, kind, { text, expected, inserted }) {
  const name = `${host}-${kind}`;
  await clearInput(name);
  await dismissKeyboard(snapshot(`${name}-empty`));
  // fill taps the input and types at once, so suggestions open while the keyboard opens.
  ad("fill", "editable=true", text);
  assertPlacement(
    `${name} opened while keyboard opens`,
    await settledPlacement(`${name}-opening`, true),
    expected,
  );
  await clearInput(`${name}-settled`);
  await waitFor(`${name}-settled-empty`, (snap) => composerText(snap) === "");
  ad("type", text);
  assertPlacement(
    `${name} opened after keyboard settled`,
    await settledPlacement(`${name}-open`, true),
    expected,
  );
  await dismissKeyboard(snapshot(`${name}-before-close`));
  assertPlacement(
    `${name} keyboard closed`,
    await settledPlacement(`${name}-closed`, false),
    expected,
  );
  focusAtEnd(snapshot(`${name}-before-reopen`));
  const reopened = assertPlacement(
    `${name} keyboard opened under open suggestions`,
    await settledPlacement(`${name}-reopened`, true),
    expected,
  );
  ad("press", String(reopened.x), String(reopened.y));
  const selected = await waitFor(`${name}-selected`, (snap) =>
    sameText(composerText(snap), inserted),
  );
  if (!keyboardShown(selected)) throw new Error(`Selecting ${expected} closed the keyboard`);
  process.stdout.write(
    `PASS ${name}: tapped ${expected}, composer now ${JSON.stringify(inserted)}\n`,
  );
}

// Drafts list commands for their selected provider, and a fresh install selects none.
async function selectClaudeModel(host) {
  ad("press", 'id="combined-model-selector"');
  await waitFor(`${host}-model-sheet`, (snap) => Boolean(nodeById(snap, "agent-controls-model")));
  ad("press", 'id="agent-controls-model"');
  await waitFor(`${host}-providers`, (snap) => Boolean(nodeById(snap, "model-provider-claude")));
  ad("press", 'id="model-provider-claude"');
  const models = await waitFor(`${host}-models`, (snap) =>
    snap.data.nodes.some((node) => node.identifier?.startsWith("model-row-claude-") && node.rect),
  );
  const row = models.data.nodes.find(
    (node) => node.identifier?.startsWith("model-row-claude-") && node.rect,
  ).rect;
  ad(
    "press",
    String(Math.round(row.x + row.width / 2)),
    String(Math.round(row.y + row.height / 2)),
  );
  await waitFor(`${host}-model-selected`, (snap) =>
    Boolean(nodeById(snap, "agent-controls-thinking")),
  );
  ad("press", 'label="Close"');
  await waitFor(`${host}-model-closed`, (snap) => !nodeById(snap, "agent-controls-model"));
}

async function runHost(host) {
  if (host !== "chat") await selectClaudeModel(host);
  await runCase(host, "commands", host === "chat" ? chatCommandCase : skillCase);
  await runCase(host, "files", fileCase);
  await runCase(host, "files-grown", {
    text: `${grownPrefix}${fileCase.text}`,
    expected: fileCase.expected,
    inserted: `${grownPrefix}${fileCase.inserted}`,
  });
  await clearInput(`${host}-done`);
  await dismissKeyboard(snapshot(`${host}-done`));
}

const hosts = [
  ["chat", `paseo://h/${serverId}/agent/${agentId}`],
  ["workspace-draft", `paseo://h/${serverId}/workspace/${workspaceId}?open=draft%3A${draftId}`],
  ["new-workspace", `paseo://new?serverId=${serverId}`],
];
for (const [host, url] of hosts) {
  ad("open", url, "--platform", "ios", "--device", device);
  await waitFor(host, (snap) => Boolean(nodeById(snap, "message-input-root")), 60_000);
  await runHost(host);
}
process.stdout.write(`Composer autocomplete placement passed. Artifacts: ${artifactsDir}\n`);
