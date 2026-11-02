// Open an existing connected compact chat in a dev client, with the keyboard closed.
// node placement.mjs <session> <platform> <cdp-target> <server-id> <coordinate-scale> <composer-label> <artifacts>
// coordinate-scale is screenshot pixels per layout point (Android density; iOS snapshots use 1).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [, , session, platform, target, serverId, coordinateScale, composerLabel, artifacts] =
  process.argv;
assert(
  session &&
    ["android", "ios"].includes(platform) &&
    target &&
    serverId &&
    composerLabel &&
    artifacts,
  "Pass all seven arguments",
);
const scale = Number(coordinateScale);
assert(scale > 0, "Pass a positive coordinate scale");
mkdirSync(artifacts, { recursive: true });
function ad(...args) {
  return execFileSync("agent-device", ["--session", session, "--platform", platform, ...args], {
    encoding: "utf8",
    timeout: 90_000,
  });
}
function evaluate(expression) {
  const result = ad("cdp", "runtime", "eval", "--expr", expression);
  assert(!result.includes("Runtime evaluation failed"), result);
}
function capture(name) {
  const snapshot = ad("snapshot", "--raw", "--json");
  writeFileSync(path.join(artifacts, `${name}.json`), snapshot);
  ad("screenshot", path.join(artifacts, `${name}.png`));
  const nodes = JSON.parse(snapshot).data.nodes;
  const header = nodes.find((node) => node.identifier === "floating-header");
  const toast = nodes.find((node) => node.identifier === "agent-updating-toast");
  assert(header?.rect && toast?.rect, "Measured header and updating toast must be present");
  assert(toast.rect.height > 0 && toast.rect.width > 0, "Toast must have visible bounds");
  const gap = (toast.rect.y - header.rect.y - header.rect.height) / scale;
  assert(Math.abs(gap - 12) <= 1, `${name}: actual header-to-toast gap ${gap}, expected12 points`);
  return toast.rect.y / scale;
}

ad("wait", `label=${JSON.stringify(composerLabel)}`, "20000");
ad("cdp", "target", "select", target);
try {
  // Hold completion of the real timeline response. No response data is synthesized.
  evaluate(`
    globalThis.__statusPlacement = {};
    (() => {
      const module = name => __r(Array.from(__r.getModules()).find(([,v]) => v.verboseName === name)[0]);
      const store = module("src/runtime/host-runtime.ts").getHostRuntimeStore();
      const owner = module("src/stores/session-store.ts").useSessionStore.getState().sessions[${JSON.stringify(serverId)}].viewedTimelineSync;
      const original = store.fetchAgentTimeline;
      const releases = [];
      let held = true;
      store.fetchAgentTimeline = async function(...args) {
        const response = await original.apply(this, args);
        if (held) await new Promise(resolve => releases.push(resolve));
        return response;
      };
      __statusPlacement.restore = () => { held = false; store.fetchAgentTimeline = original; releases.forEach(resolve => resolve()); };
      owner.setActive(false);
      owner.setActive(true);
    })();
  `);
  ad("wait", 'id="agent-updating-toast"', "15000");
  const closedTop = capture("keyboard-closed");
  ad("press", `label=${JSON.stringify(composerLabel)}`);
  const opened = ad("snapshot", "--raw", "--json");
  const nodes = JSON.parse(opened).data.nodes;
  assert(
    nodes.some(
      (node) => /keyboard/i.test(node.type ?? "") || /inputmethod/i.test(node.bundleId ?? ""),
    ),
    "Use a real visible software keyboard; open Android sessions with --no-test-ime",
  );
  const openTop = capture("keyboard-open");
  assert(Math.abs(openTop - closedTop) <= 1, "Keyboard must not translate the toast");
  console.log("PASS: rendered toast stays12 points below measured header, keyboard closed/open");
} finally {
  evaluate("globalThis.__statusPlacement?.restore?.(); delete globalThis.__statusPlacement;");
}
