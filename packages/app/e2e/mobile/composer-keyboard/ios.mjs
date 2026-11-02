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
const scenario = env("SCENARIO", "all");
if (!serverId || !workspaceId || (scenario === "all" && !agentId)) {
  throw new Error(
    "Set PASEO_COMPOSER_KEYBOARD_SERVER_ID, _AGENT_ID (an idle chat) and _WORKSPACE_ID (its workspace)",
  );
}
const draftId = env("DRAFT_ID", "composer-keyboard");
const session = env("SESSION", "composer-keyboard-ios");
const device = env("DEVICE", "iPhone 16 Pro");
const udid = env("UDID");
const deviceArgs = udid ? ["--udid", udid] : ["--device", device];
const artifactsDir = env(
  "ARTIFACTS_DIR",
  path.join(repoRoot, ".dev/agent-device-artifacts/composer-keyboard-ios"),
);
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
  return execFileSync("agent-device", [args[0], "--session", session, ...args.slice(1)], {
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
  const placement = resolveAutocompletePlacement(snap, { expected, anchorGap: 12 });
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
  for (let remaining = length + 2; remaining > 0; remaining -= 100) {
    ad(
      "press",
      String(Math.round(deleteKey.x + deleteKey.width / 2)),
      String(Math.round(deleteKey.y + deleteKey.height / 2)),
      "--count",
      String(Math.min(remaining, 100)),
      "--interval-ms",
      "40",
    );
  }
}

// The accessibility value drops a trailing space.
const sameText = (actual, expected) => actual.trimEnd() === expected.trimEnd();

async function selectRow(name, row, inserted) {
  ad("press", String(row.x), String(row.y));
  const selected = await waitFor(`${name}-selected`, (snap) =>
    sameText(composerText(snap), inserted),
  );
  if (!keyboardShown(selected)) throw new Error(`Selecting ${row.label} closed the keyboard`);
  process.stdout.write(
    `PASS ${name}: tapped ${row.label}, composer now ${JSON.stringify(inserted)}\n`,
  );
}

async function runCase(host, kind, { text, expected, inserted, selectionKeyboard = "reopened" }) {
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
  const opened = assertPlacement(
    `${name} opened after keyboard settled`,
    await settledPlacement(`${name}-open`, true),
    expected,
  );
  if (selectionKeyboard === "shown") {
    await selectRow(name, opened, inserted);
    return;
  }
  await dismissKeyboard(snapshot(`${name}-before-close`));
  const closed = assertPlacement(
    `${name} keyboard closed`,
    await settledPlacement(`${name}-closed`, false),
    expected,
  );
  if (selectionKeyboard === "hidden") {
    await selectRow(name, closed, inserted);
    return;
  }
  focusAtEnd(snapshot(`${name}-before-reopen`));
  const reopened = assertPlacement(
    `${name} keyboard opened under open suggestions`,
    await settledPlacement(`${name}-reopened`, true),
    expected,
  );
  await selectRow(name, reopened, inserted);
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

// These cases use the selected draft provider's real skills. Run on a 402pt-wide
// iPhone for growth and a small phone (SE) for previews, with Codex selected.
async function runLiveGrowth() {
  await clearInput("live-growth");
  ad("type", "Please do the following now /paseo");
  const before = await settledPlacement("live-growth-before", true);
  assertPlacement("before growth", before, "/paseo");
  const inputHeight = (snap) =>
    snap.data.nodes.find((node) => node.type === "TextView").rect.height;
  ad("type", "--", "-committee");
  const grown = await settledPlacement("live-growth-after", true);
  if (inputHeight(grown) <= inputHeight(before))
    throw new Error("Draft did not wrap onto a new line");
  assertPlacement("live growth without reopening", grown, "/paseo-committee");
  const deleteKey = grown.data.nodes.find(
    (node) => node.type === "Key" && node.label === "delete",
  ).rect;
  ad(
    "press",
    String(deleteKey.x + deleteKey.width / 2),
    String(deleteKey.y + deleteKey.height / 2),
    "--count",
    "10",
    "--interval-ms",
    "40",
  );
  const shrunk = await settledPlacement("live-growth-shrunk", true);
  if (inputHeight(shrunk) !== inputHeight(before))
    throw new Error("Draft did not shrink back to one line");
  assertPlacement("live shrink without reopening", shrunk, "/paseo");
  ad("type", "--", "-committ");
  const partial = await settledPlacement("live-growth-partial", true);
  if (!sameText(composerText(partial), "Please do the following now /paseo-committ")) {
    throw new Error("Could not prepare a partial command for selection");
  }
  const row = assertPlacement("partial command after growth", partial, "/paseo-committee");
  ad("press", String(row.x), String(row.y));
  await waitFor("live-growth-selected", (snap) =>
    sameText(composerText(snap), "Please do the following now /paseo-committee "),
  );
  await clearInput("live-growth-done");
}

async function runBoundedPreview() {
  const prefix =
    "Please do the following / testing inline selection.\n" +
    "Line two with details.\nLine three with details.\nLine four with details.\n" +
    "Line five with details.\nLine six with details.\nLine seven with details.\nPlease use ";
  await runCase("preview", "long", {
    text: `${prefix}/openai`,
    expected: "/openai-docs",
    inserted: `${prefix}/openai-docs `,
    selectionKeyboard: "shown",
  });
  await runCase("preview", "long-hidden", {
    text: `${prefix}/openai`,
    expected: "/openai-docs",
    inserted: `${prefix}/openai-docs `,
    selectionKeyboard: "hidden",
  });
  await runCase("preview", "longest", {
    text: `${prefix}/paseo-plug`,
    expected: "/paseo-plugin",
    inserted: `${prefix}/paseo-plugin `,
    selectionKeyboard: "shown",
  });
  await runCase("preview", "short", {
    text: `${prefix}/com`,
    expected: "/commit",
    inserted: `${prefix}/commit `,
    selectionKeyboard: "shown",
  });
  await runCase("preview", "files", fileCase);
}

if (scenario !== "all") {
  ad(
    "open",
    `paseo://h/${serverId}/workspace/${workspaceId}?open=draft%3A${draftId}`,
    "--platform",
    "ios",
    ...deviceArgs,
  );
  await waitFor("draft", (snap) => Boolean(nodeById(snap, "message-input-root")), 60_000);
  if (scenario === "growth") await runLiveGrowth();
  else if (scenario === "previews") await runBoundedPreview();
  else throw new Error(`Unknown scenario: ${scenario}`);
  process.stdout.write(`Composer ${scenario} regression passed. Artifacts: ${artifactsDir}\n`);
  process.exit(0);
}

const hosts = [
  ["chat", `paseo://h/${serverId}/agent/${agentId}`],
  ["workspace-draft", `paseo://h/${serverId}/workspace/${workspaceId}?open=draft%3A${draftId}`],
  ["new-workspace", `paseo://new?serverId=${serverId}`],
];
for (const [host, url] of hosts) {
  ad("open", url, "--platform", "ios", ...deviceArgs);
  await waitFor(host, (snap) => Boolean(nodeById(snap, "message-input-root")), 60_000);
  await runHost(host);
}
process.stdout.write(`Composer autocomplete placement passed. Artifacts: ${artifactsDir}\n`);
