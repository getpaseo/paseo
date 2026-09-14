// Run against a native dev app loaded from this checkout:
// node packages/app/e2e/mobile/clipboard-image.mjs <metro-port> <app-id>
// Exercises real native attachment persistence; Node's fetch(data:) hides this regression.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const [, , metroPort, appId] = process.argv;
assert(metroPort && appId, "Pass the Metro port and native app ID");
const targets = await fetch(`http://127.0.0.1:${Number(metroPort)}/json/list`).then((r) =>
  r.json(),
);
const target = targets.find((candidate) => candidate.appId === appId);
assert(target, `Missing Hermes target for ${appId}`);
const png = await readFile(new URL("../../assets/images/icon.png", import.meta.url));
const base64 = png.toString("base64");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

let nextId = 0;
function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Hermes evaluation timed out"));
    }, 10000);
    function onMessage(message) {
      const response = JSON.parse(message.toString());
      if (response.id !== id) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      if (response.error || response.result.exceptionDetails) {
        reject(new Error(JSON.stringify(response.error ?? response.result.exceptionDetails)));
      } else {
        resolve(response.result.result.value);
      }
    }
    socket.on("message", onMessage);
    socket.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true },
      }),
    );
  });
}

async function waitForNativeClipboardImage() {
  const deadline = Date.now() + 15000;
  do {
    const result = await evaluate("globalThis.__clipboardImageTest");
    if (result) return result;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail("Native image persistence timed out");
}

try {
  // Metro's debugger module table locates the same public service used by the composer.
  // Hermes does not await promises through Runtime.evaluate, so collect the async result.
  await evaluate(`(() => {
    const entry = Array.from(__r.getModules().entries()).find(
      ([, module]) => module.verboseName === "src/attachments/service.ts"
    );
    if (!entry) throw new Error("Open the composer before running this test");
    const service = __r(entry[0]);
    globalThis.__clipboardImageTest = null;
    service.persistAttachmentFromDataUrl({
      dataUrl: ${JSON.stringify(`data:image/png;base64,${base64}`)},
      fileName: "clipboard.png"
    }).then(attachment => {
      return Promise.all([
        service.encodeAttachmentsForSend([attachment]),
        service.resolveAttachmentPreviewUrl(attachment)
      ]).then(([encoded, preview]) => ({ attachment, encoded, preview }))
        .finally(() => service.deleteAttachments([attachment]));
    }).then(result => { globalThis.__clipboardImageTest = result; })
      .catch(error => { globalThis.__clipboardImageTest = { error: String(error) }; });
  })()`);
  const result = await waitForNativeClipboardImage();
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.attachment.storageType, "native-file");
  assert.equal(result.attachment.byteSize, png.length);
  assert.equal(result.attachment.fileName, "clipboard.png");
  assert.match(result.preview, /^file:\/\//);
  assert.deepEqual(result.encoded, [{ data: base64, mimeType: "image/png" }]);
  console.log(`PASS: native clipboard PNG persisted, previewed, and encoded (${png.length} bytes)`);
} finally {
  await evaluate("delete globalThis.__clipboardImageTest").finally(() => socket.close());
}
