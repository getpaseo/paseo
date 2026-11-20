// Start on Settings > Host > Pair device with relay enabled in the Android app.
// node packages/app/e2e/mobile/pair-device/android.mjs <agent-device-session>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [, , session] = process.argv;
assert(session, "Pass the agent-device session for the connected Android app");

function ad(...args) {
  return execFileSync("agent-device", [...args, "--session", session], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

ad(
  "press",
  'label="Pair a device, Scan a QR code or copy a link to connect your phone to this host"',
  "--settle",
);
ad("wait", "text", "Pairing QR code", "10000");
const { data } = JSON.parse(ad("snapshot", "-i", "--json"));
const sheet = data.nodes.find((node) => node.label === "Bottom Sheet");
const qr = data.nodes.find((node) => node.label === "Pairing QR code");
assert(sheet?.rect, "Pairing sheet must be visible");
assert(qr?.rect, "Pairing QR code must be visible");
assert(qr.rect.x > sheet.rect.x, "QR must have an unclipped left margin inside the sheet");
assert(
  qr.rect.x + qr.rect.width < sheet.rect.x + sheet.rect.width,
  "QR must have an unclipped right margin inside the sheet",
);
assert(Math.abs(qr.rect.width - qr.rect.height) <= 1, "Complete QR must remain square");
assert(qr.rect.y >= sheet.rect.y, "QR top must be visible inside the sheet");
assert(
  qr.rect.y + qr.rect.height <= sheet.rect.y + sheet.rect.height,
  "QR bottom must be visible inside the sheet",
);
assert(
  data.nodes.some((node) => node.label === "Copy" && node.enabled),
  "Copy must remain available",
);
console.log("PASS: complete square QR fits inside the pairing sheet", qr.rect);
ad("press", 'label="Close"', "--settle");
