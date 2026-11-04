// Assert geometry from a fresh agent-device snapshot --raw --json capture.
// node assert-footer-clear.mjs <snapshot.json> <composer-pill-label>
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [, , snapshotPath, pillLabel] = process.argv;
assert(snapshotPath && pillLabel, "Pass a snapshot JSON path and composer pill label");
const { data } = JSON.parse(readFileSync(snapshotPath, "utf8"));
const buttons = data.nodes.filter((node) => node.type === "android.widget.Button");
const pill = buttons.find((node) => node.label === pillLabel);
assert(pill?.rect, `Composer pill '${pillLabel}' must be visible`);
for (const label of ["Copy turn", "Fork chat from here"]) {
  const button = buttons.find((node) => node.label === label);
  assert(button?.rect, `Completed-turn action '${label}' must be visible`);
  const bottom = button.rect.y + button.rect.height;
  assert(
    bottom <= pill.rect.y,
    `${label} ends at ${bottom}, below composer pill top ${pill.rect.y}`,
  );
}
console.log("PASS: completed-turn actions remain fully above the composer pill");
