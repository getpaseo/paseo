import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const session = process.argv[2];
assert(session, "Pass an Android agent-device session serving native.tsx");
function ad(...args) {
  return execFileSync("agent-device", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

function assertMeasurementParity(mode) {
  const snapshot = JSON.parse(ad("snapshot", "--raw", "--json"));
  assert.equal(snapshot.success, true);
  const nodes = snapshot.data.nodes;
  let last = nodes.find((node) => node.label?.endsWith("End of measurement fixture."));
  assert(last?.rect, "The last paragraph must be visible, including its bottom");
  // EnrichedMarkdownText exposes paragraph accessibility nodes inside its TextView;
  // EnrichedMarkdown exposes the TextViews themselves. Measure the native child.
  let host = nodes.find((node) => node.index === last.parentIndex);
  if (host?.type === "android.widget.TextView") {
    last = host;
    host = nodes.find((node) => node.index === last.parentIndex);
  }
  assert.equal(host?.type, "android.widget.FrameLayout");
  const viewport = nodes.find((node) => node.type === "android.widget.ScrollView");
  const footer = nodes.find((node) => node.label === "End of Markdown host");
  assert(viewport?.rect && footer?.rect, "The fixture and footer must be visible");
  assert(
    host.rect.y >= viewport.rect.y &&
      footer.rect.y + footer.rect.height <= viewport.rect.y + viewport.rect.height,
    "The whole fixture must fit in the viewport; clipped bounds cannot prove parity",
  );
  const hostBottom = host.rect.y + host.rect.height;
  const childBottom = last.rect.y + last.rect.height;
  console.log(
    JSON.stringify({
      mode,
      host: host.rect,
      lastChild: last.rect,
      surplus: hostBottom - childBottom,
    }),
  );
  assert(
    Math.abs(hostBottom - childBottom) <= 1,
    `Markdown reserves blank space in ${mode}: host bottom ${hostBottom}, last child bottom ${childBottom}`,
  );
}

ad("press", 'label="Show wrapping fixture"');
ad("wait", "text", "End of Markdown host", "10000");
assertMeasurementParity("regular");
ad("press", 'label="Use compact text"');
ad("wait", "text", "Use regular text", "10000");
assertMeasurementParity("compact");
ad("press", 'label="Use regular text"');
ad("wait", "text", "Use compact text", "10000");
assertMeasurementParity("regular restored");
console.log("PASS Android Markdown host measurement matches its last child");
