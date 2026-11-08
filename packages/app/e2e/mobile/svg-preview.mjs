// Open an SVG file preview in a native app loaded from this checkout first.
// node packages/app/e2e/mobile/svg-preview.mjs <agent-device-session>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [, , session] = process.argv;
assert(session, "Pass the agent-device session with an SVG preview open");
function ad(...args) {
  return execFileSync("agent-device", [...args, "--session", session], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

// The canvas only mounts once the native decoder has returned image dimensions.
// A file name or an image placeholder alone does not establish a successful load.
ad("wait", 'id="image-file-preview-canvas"', "10000");
ad("wait", 'role=button label="Zoom in"', "10000");
ad("press", 'role=button label="Zoom in"', "--settle");
assert.equal(
  JSON.parse(ad("get", "attrs", 'role=button label="Reset view"', "--json")).data.node.enabled,
  true,
  "Zooming enables Reset view",
);
ad("press", 'role=button label="Reset view"', "--settle");
assert.equal(
  JSON.parse(ad("get", "attrs", 'role=button label="Reset view"', "--json")).data.node.enabled,
  false,
  "Reset returns to the fitted view",
);
console.log("PASS: native SVG decoded, zoomed, and reset");
