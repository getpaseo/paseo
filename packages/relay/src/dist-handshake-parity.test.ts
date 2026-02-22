import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENCRYPTED_CHANNEL_PATH = path.resolve(THIS_DIR, "../dist/encrypted-channel.js");

describe("relay dist handshake parity", () => {
  it("keeps Node dist handshake message types in sync with src", () => {
    const distCode = readFileSync(DIST_ENCRYPTED_CHANNEL_PATH, "utf8");

    expect(distCode).toContain('type: "e2ee_hello"');
    expect(distCode).toContain('type: "e2ee_ready"');

    // Guard against accidentally shipping the legacy hello/ready protocol.
    expect(distCode).not.toMatch(/\btype:\s*"hello"\b/);
    expect(distCode).not.toMatch(/\btype:\s*"ready"\b/);
  });
});

