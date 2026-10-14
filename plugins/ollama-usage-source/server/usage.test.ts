import { createPublicKey, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { signinKeyPath } from "./signin.js";
import { discover, fetchUsage } from "./usage.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ollama-usage-home-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

function sshString(value: Buffer | string): Buffer {
  const body = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

/** Writes an unencrypted OpenSSH ed25519 key pair, the format `ollama signin` uses. */
async function writeSigninKey(home: string): Promise<{ publicKey: KeyObject; sshPublic: string }> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const publicBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(raw)]);
  const check = Buffer.alloc(8);
  const inner = Buffer.concat([
    check,
    sshString("ssh-ed25519"),
    sshString(raw),
    sshString(Buffer.concat([seed, raw])),
    sshString("test"),
  ]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "latin1"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    Buffer.from([0, 0, 0, 1]),
    sshString(publicBlob),
    sshString(inner),
  ]);
  const sshPublic = publicBlob.toString("base64");
  const keyPath = signinKeyPath(home);
  await mkdir(path.dirname(keyPath), { recursive: true });
  await writeFile(
    keyPath,
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString("base64")}\n-----END OPENSSH PRIVATE KEY-----\n`,
  );
  await writeFile(`${keyPath}.pub`, `ssh-ed25519 ${sshPublic}\n`);
  return {
    publicKey: createPublicKey(publicKey.export({ format: "pem", type: "spki" })),
    sshPublic,
  };
}

interface FakeCloud {
  fetch: typeof fetch;
  requests: IncomingMessage[];
}

async function fakeCloud(responses: Record<string, Record<string, unknown>>): Promise<FakeCloud> {
  const requests: IncomingMessage[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(request);
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const body = responses[pathname];
    response.statusCode = body ? 200 : 404;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body ?? { error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const fetchApi: typeof fetch = async (input, init) => {
    const target = typeof input === "string" ? input : (input as Request).url;
    return fetch(target.replace("https://ollama.com", `http://127.0.0.1:${port}`), init);
  };
  return { fetch: fetchApi, requests };
}

const legacyBalance = {
  included: {
    session: { remaining_percent: 75, resets_at: "2026-10-01T07:00:00Z" },
    weekly: { remaining_percent: 40, resets_at: "2026-10-05T00:00:00Z" },
  },
  purchased: { balance_usd: 0 },
};

test("discover prefers the ollama signin key, then OLLAMA_API_KEY", async () => {
  const home = await tempHome();
  const env = { HOME: home, OLLAMA_API_KEY: "env-key" };

  expect((await discover(env))[0]?.input).toEqual({
    source: "env",
    locator: "OLLAMA_API_KEY",
  });
  expect(await discover({ HOME: home })).toEqual([]);

  await writeSigninKey(home);
  expect((await discover(env))[0]?.input).toEqual({
    source: "signin",
    keyPath: signinKeyPath(home),
  });
});

test("fetch signs requests with the ollama signin key", async () => {
  const home = await tempHome();
  const { publicKey, sshPublic } = await writeSigninKey(home);
  const cloud = await fakeCloud({ "/api/balance": legacyBalance, "/api/me": { plan: "pro" } });

  const report = await fetchUsage({ source: "signin", keyPath: signinKeyPath(home) }, cloud.fetch);

  expect(report).toMatchObject({ status: "available", planLabel: "Pro" });
  const balance = cloud.requests.find((request) => request.url?.startsWith("/api/balance"));
  const url = new URL(balance?.url ?? "/", "http://localhost");
  const [keyPart, signature] = (balance?.headers.authorization ?? "").split(":");
  expect(keyPart).toBe(sshPublic);
  const challenge = `GET,/api/balance?ts=${url.searchParams.get("ts")}`;
  expect(
    verify(null, Buffer.from(challenge), publicKey, Buffer.from(signature ?? "", "base64")),
  ).toBe(true);
});

test("fetch maps included balance windows", async () => {
  const cloud = await fakeCloud({
    "/api/balance": {
      included: {
        balance_usd: 72.5,
        allowance_usd: 100,
        period: { from: "2026-09-15T09:30:00Z", until: "2026-10-15T09:30:00Z" },
      },
      purchased: { balance_usd: 25 },
    },
  });
  const report = await fetchUsage({ source: "env", locator: "OLLAMA_API_KEY" }, cloud.fetch, {
    OLLAMA_API_KEY: "test-key",
  });
  expect(report.status).toBe("available");
  if (report.status !== "available") return;
  expect(report.windows[0]?.usedPct).toBeCloseTo(27.5);
  expect(report.balances?.[0]?.remaining).toBe(72.5);
  expect(report.balances?.[1]?.remaining).toBe(25);
  expect(cloud.requests[0]?.headers.authorization).toBe("Bearer test-key");
});

test("fetch maps legacy session and weekly limits", async () => {
  const cloud = await fakeCloud({ "/api/balance": legacyBalance });
  const report = await fetchUsage({ source: "env", locator: "OLLAMA_API_KEY" }, cloud.fetch, {
    OLLAMA_API_KEY: "test-key",
  });
  expect(report.status).toBe("available");
  if (report.status !== "available") return;
  expect(report.windows.map((window) => window.usedPct)).toEqual([25, 60]);
});
