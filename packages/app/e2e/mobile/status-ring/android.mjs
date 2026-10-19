import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const [, , session, metroUrl] = process.argv;
assert(session && metroUrl, "Pass an agent-device session and Metro URL serving native.tsx");
function ad(...args) {
  return execFileSync("agent-device", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
}
function evaluate(expression) {
  const value = ad("cdp", "runtime", "eval", "--expr", expression, "--json").trim();
  return value === "undefined" ? undefined : JSON.parse(value);
}
let target;
const deadline = Date.now() + 30_000;
do {
  target = ad("cdp", "target", "list", "--url", metroUrl)
    .split("\n")
    .find((line) => line.includes("sh.paseo.debug"));
  if (!target) await delay(250);
} while (!target && Date.now() < deadline);
assert(target, "Open the Android dev client on this Metro bundle first");
ad("cdp", "target", "select", target.split(/\s+/)[0]);
let ready = false;
do {
  ready = evaluate("Object.keys(globalThis.__ringReaders ?? {}).length === 2");
  if (!ready) await delay(250);
} while (!ready && Date.now() < deadline);
assert(ready, "The two native probes must mount before sampling");
async function sample() {
  evaluate("Object.values(globalThis.__ringReaders).forEach(read => read())");
  await delay(100);
  return JSON.parse(evaluate("JSON.stringify(globalThis.__ringSamples)"));
}
async function observe(label) {
  const before = await sample();
  await delay(600);
  const after = await sample();
  const deltas = Object.fromEntries(
    Object.keys(before).map((key) => [key, after[key].updates - before[key].updates]),
  );
  console.log(JSON.stringify({ label, deltas, after }));
  return { deltas, after };
}
const visible = await observe("both visible");
assert(visible.deltas.first > 0 && visible.deltas.second > 0);
assert.equal(visible.after.first.rotation, visible.after.second.rotation);
ad("press", 'label="HIDE FIRST"');
await delay(200);
const hidden = await observe("first hidden, second visible");
assert.equal(hidden.deltas.first, 0, "A retained hidden ring must stop UI-thread rotation updates");
assert(hidden.deltas.second > 0, "Visible rings must continue rotating");
ad("press", 'label="HIDE SECOND"');
await delay(200);
const allHidden = await observe("both hidden");
assert.equal(allHidden.deltas.first, 0);
assert.equal(allHidden.deltas.second, 0);
ad("press", 'label="SHOW FIRST"');
ad("press", 'label="SHOW SECOND"');
await delay(200);
const restored = await observe("both shown again");
assert(restored.deltas.first > 0 && restored.deltas.second > 0);
assert.equal(
  restored.after.first.rotation,
  restored.after.second.rotation,
  "Restored rings must share the current phase",
);
console.log("PASS native retained-ring lifecycle");
