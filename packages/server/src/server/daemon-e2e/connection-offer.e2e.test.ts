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

describe("ConnectionOfferV2 (daemon E2E)", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test("emits relay-only offer URL with stable serverId", async () => {
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
        serverId: string;
        daemonPublicKeyB64: string;
        relay: { endpoint: string };
      };

      expect(offer.v).toBe(2);
      expect(typeof offer.serverId).toBe("string");
      expect(offer.serverId.length).toBeGreaterThan(0);
      expect(offer.serverId.startsWith("srv_")).toBe(true);
      expect(offer.relay.endpoint).toBe("relay.paseo.sh:443");
      expect(typeof offer.daemonPublicKeyB64).toBe("string");
      expect(offer.daemonPublicKeyB64.length).toBeGreaterThan(0);
      expect(() => Buffer.from(offer.daemonPublicKeyB64, "base64")).not.toThrow();

      expect("endpoints" in offer).toBe(false);
    } finally {
      await daemon.close();
    }
  });

  test("persists serverId and daemon keypair across daemon restarts", async () => {
    process.env.PASEO_PRIMARY_LAN_IP = "192.168.1.12";

    const tempHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-offer-home-"));

    const { logger: logger1, lines: lines1 } = createCapturingLogger();
    const daemon1 = await createTestPaseoDaemon({
      listen: "0.0.0.0",
      logger: logger1,
      relayEnabled: true,
      paseoHomeRoot: tempHomeRoot,
      cleanup: false,
    });

    let staticDir1: string | null = daemon1.staticDir;
    let staticDir2: string | null = null;

    try {
      const offerUrl1 = parseOfferUrlFromLogs(lines1);
      const offer1 = decodeOfferFromFragmentUrl(offerUrl1) as {
        serverId: string;
        daemonPublicKeyB64: string;
        relay: { endpoint: string };
      };

      await daemon1.close();

      const { logger: logger2, lines: lines2 } = createCapturingLogger();
      const daemon2 = await createTestPaseoDaemon({
        listen: "0.0.0.0",
        logger: logger2,
        relayEnabled: true,
        paseoHomeRoot: tempHomeRoot,
        cleanup: false,
      });
      staticDir2 = daemon2.staticDir;

      try {
        const offerUrl2 = parseOfferUrlFromLogs(lines2);
        const offer2 = decodeOfferFromFragmentUrl(offerUrl2) as {
          serverId: string;
          daemonPublicKeyB64: string;
          relay: { endpoint: string };
        };

        expect(offer2.serverId).toBe(offer1.serverId);
        expect(offer2.daemonPublicKeyB64).toBe(offer1.daemonPublicKeyB64);
        expect(offer2.relay.endpoint).toBe(offer1.relay.endpoint);
      } finally {
        await daemon2.close();
      }
    } finally {
      await rm(tempHomeRoot, { recursive: true, force: true });
      if (staticDir1) {
        await rm(staticDir1, { recursive: true, force: true });
        staticDir1 = null;
      }
      if (staticDir2) {
        await rm(staticDir2, { recursive: true, force: true });
        staticDir2 = null;
      }
    }
  });

  test(
    "respects --no-relay (CLI) by not emitting a pairing offer",
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
        PASEO_LOCAL_AUTO_DOWNLOAD: "0",
        PASEO_LOG_FORMAT: "json",
      };

      const stdoutLines: string[] = [];
      const proc = spawn(tsxBin, [indexPath, "--no-relay"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      try {
        const directConnect = await new Promise<{ endpoints: string[] }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            proc.kill();
            reject(new Error("timed out waiting for direct_connect log"));
          }, 15000);

          const onData = (data: Buffer) => {
            const text = data.toString("utf8");
            stdoutLines.push(text);
            for (const line of text.split("\n")) {
              if (!line.trim()) continue;
              if (line.includes("pairing_offer")) {
                clearTimeout(timeout);
                reject(new Error("unexpected pairing_offer log when --no-relay is set"));
                return;
              }
              if (!line.includes("direct_connect")) continue;
              try {
                const parsed = JSON.parse(line) as { msg?: string; endpoints?: unknown };
                if (parsed.msg !== "direct_connect") continue;
                const endpoints = Array.isArray(parsed.endpoints)
                  ? parsed.endpoints.filter((v) => typeof v === "string")
                  : [];
                if (endpoints.length === 0) continue;
                clearTimeout(timeout);
                resolve({ endpoints });
                return;
              } catch {
                // ignore
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

        expect(directConnect.endpoints).toContain(`localhost:${port}`);
        expect(directConnect.endpoints).toContain(`192.168.1.12:${port}`);
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
