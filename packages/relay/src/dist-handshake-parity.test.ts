import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENCRYPTED_CHANNEL_PATH = path.resolve(THIS_DIR, "../dist/encrypted-channel.js");
const RELAY_PACKAGE_ROOT = path.resolve(THIS_DIR, "..");

function readBuiltEncryptedChannel(): string {
  if (!existsSync(DIST_ENCRYPTED_CHANNEL_PATH)) {
    execFileSync("npm", ["run", "build"], {
      cwd: RELAY_PACKAGE_ROOT,
      stdio: "inherit",
    });
  }

  return readFileSync(DIST_ENCRYPTED_CHANNEL_PATH, "utf8");
}

describe("relay dist handshake parity", () => {
  it("keeps Node dist handshake message types in sync with src", () => {
    const distCode = readBuiltEncryptedChannel();

    expect(distCode).toContain('type: "e2ee_hello"');
    expect(distCode).toContain('type: "e2ee_ready"');

    // Guard against accidentally shipping the legacy hello/ready protocol.
    expect(distCode).not.toMatch(/\btype:\s*"hello"\b/);
    expect(distCode).not.toMatch(/\btype:\s*"ready"\b/);
  });
});
