import { afterEach, describe, expect, test } from "vitest";
import pino from "pino";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { Writable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

function createCapturingLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString("utf8"));
      cb();
    },
  });
  const logger = pino({ level: "info" }, stream);
  return { logger, lines };
}

function parseOfferUrlFromLogs(lines: string[]): string {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as { msg?: string; url?: string };
      if (obj.msg === "pairing_offer" && typeof obj.url === "string") {
        return obj.url;
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  throw new Error(`pairing_offer log not found. saw ${lines.length} lines`);
}

function decodeOfferFromFragmentUrl(url: string): unknown {
  const marker = "#offer=";
  const idx = url.indexOf(marker);
  if (idx === -1) {
    throw new Error(`missing ${marker} fragment: ${url}`);
  }
  const encoded = url.slice(idx + marker.length);
  const json = Buffer.from(encoded, "base64url").toString("utf8");
  return JSON.parse(json) as unknown;
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

describe("ConnectionOfferV1 (daemon E2E)", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test("emits offer URL with sessionId + host:port endpoints (includes relay unless opted out)", async () => {
    process.env.PASEO_PRIMARY_LAN_IP = "192.168.1.12";

    const { logger, lines } = createCapturingLogger();

    const daemon = await createTestPaseoDaemon({
      listen: "0.0.0.0",
      logger,
      relayEnabled: true,
    });

    try {
      const offerUrl = parseOfferUrlFromLogs(lines);
      expect(offerUrl.startsWith("https://app.paseo.sh/#offer=")).toBe(true);

      const offer = decodeOfferFromFragmentUrl(offerUrl) as {
        v: number;
        sessionId: string;
        endpoints: string[];
        daemonPublicKeyB64: string;
      };

      expect(offer.v).toBe(1);
      expect(typeof offer.sessionId).toBe("string");
      expect(offer.sessionId.length).toBeGreaterThan(0);
      expect(Array.isArray(offer.endpoints)).toBe(true);
      expect(offer.endpoints).toContain(`192.168.1.12:${daemon.port}`);
      expect(offer.endpoints).toContain(`localhost:${daemon.port}`);
      expect(offer.endpoints).toContain("relay.paseo.sh:443");
      expect(typeof offer.daemonPublicKeyB64).toBe("string");
      expect(offer.daemonPublicKeyB64.length).toBeGreaterThan(0);
      expect(() => Buffer.from(offer.daemonPublicKeyB64, "base64")).not.toThrow();
    } finally {
      await daemon.close();
    }
  });

  test(
    "respects --no-relay (CLI) by omitting relay endpoint from offer",
    async () => {
      process.env.PASEO_PRIMARY_LAN_IP = "192.168.1.12";

      const tempHome = await mkdtemp(path.join(os.tmpdir(), "paseo-offer-e2e-"));
      const port = await getAvailablePort();

      const indexPath = fileURLToPath(new URL("../index.ts", import.meta.url));
      const tsxBin = path.resolve(process.cwd(), "../../node_modules/.bin/tsx");

      const env = {
        ...process.env,
        PASEO_HOME: tempHome,
        PASEO_LISTEN: `0.0.0.0:${port}`,
        OPENAI_API_KEY: "",
      };

      const stdoutLines: string[] = [];
      const proc = spawn(tsxBin, [indexPath, "--no-relay"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      try {
        const offerUrl = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            proc.kill();
            reject(new Error("timed out waiting for pairing_offer log"));
          }, 15000);

          const onData = (data: Buffer) => {
            const text = data.toString("utf8");
            stdoutLines.push(text);
            for (const line of text.split("\n")) {
              if (!line.trim()) continue;
              if (!line.includes("pairing_offer")) continue;
              const match = line.match(/"url":"([^"]+)"/);
              if (match) {
                clearTimeout(timeout);
                resolve(match[1]);
                return;
              }
            }
          };

          proc.stdout?.on("data", onData);
          proc.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });
          proc.on("exit", (code) => {
            if (code && code !== 0) {
              clearTimeout(timeout);
              reject(new Error(`daemon process exited early with code ${code}`));
            }
          });
        });

        const offer = decodeOfferFromFragmentUrl(offerUrl) as {
          endpoints: string[];
        };

        expect(offer.endpoints).not.toContain("relay.paseo.sh:443");
        expect(offer.endpoints).toContain(`localhost:${port}`);
        expect(offer.endpoints).toContain(`192.168.1.12:${port}`);
      } catch (err) {
        throw new Error(
          `failed; stdout so far:\\n${stdoutLines.join("")}\\n\\n${String(err)}`
        );
      } finally {
        proc.kill();
        await rm(tempHome, { recursive: true, force: true });
      }
    },
    30000
  );
});
