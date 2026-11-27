import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostSummary } from "@getpaseo/client";

const host: HostSummary = {
  registrationId: "hst_bakery",
  serverId: "srv_bakery",
  label: "Bakery",
  source: { id: "owner", key: "fixture" },
  metadata: {},
  enabled: true,
  status: "online",
  targetDescription: "ssh://bakery:22 (daemon port 6767)",
  lastOnlineAt: null,
  nextRetryAt: null,
  error: null,
};
const token = "a".repeat(64);
const addHost = vi.fn(async () => host);
const updateHost = vi.fn(async () => host);
const listHosts = vi.fn(async () => ({ hosts: [host] }));
const close = vi.fn(async () => undefined);
let hostBidirectionalLinks: boolean | undefined;

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    getLastServerInfoMessage: () => ({ features: { hostBidirectionalLinks } }),
    addHost,
    updateHost,
    listHosts,
    close,
  })),
}));

import { createHostCommand } from "./index.js";

let tokenFile: string;
let directory: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  vi.clearAllMocks();
  hostBidirectionalLinks = true;
  directory = await mkdtemp(join(tmpdir(), "paseo-host-cli-"));
  tokenFile = join(directory, "reverse-token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`CLI exited with status ${code}`);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function run(args: string[]) {
  return createHostCommand().parseAsync(args, { from: "user" });
}

it("enables and disables reverse access on an existing registration", async () => {
  await run([
    "enable-reverse",
    "hst_bakery",
    "--token-file",
    tokenFile,
    "--permission",
    "daemon.read",
    "--permission",
    "workspace.read",
    "--json",
  ]);
  await run(["disable-reverse", "hst_bakery", "--json"]);

  expect(updateHost.mock.calls).toEqual([
    ["hst_bakery", { reverseOffer: { token, permissions: ["daemon.read", "workspace.read"] } }],
    ["hst_bakery", { reverseOffer: null }],
  ]);
  expect(stdout.join("")).not.toContain(token);
  expect(stderr).toEqual([]);
  expect(close).toHaveBeenCalledTimes(2);
});

it("preapproves a passive registration by the dialer's server ID", async () => {
  await run(["accept-reverse", "srv_mac", "--token-file", tokenFile, "--label", "Mac", "--json"]);

  expect(addHost).toHaveBeenCalledWith({
    connection: "reverse://srv_mac",
    incomingToken: token,
    label: "Mac",
  });
  expect(stdout.join("")).not.toContain(token);
  expect(stderr).toEqual([]);
});

it.each([
  ["enable-reverse", "hst_bakery", "--token-file", "unused", "--permission", "daemon.read"],
  ["disable-reverse", "hst_bakery"],
  ["accept-reverse", "srv_mac", "--token-file", "unused"],
])("requires daemon support for %s before making a mutation", async (...args) => {
  hostBidirectionalLinks = undefined;
  await expect(run([...args, "--json"])).rejects.toThrow("CLI exited with status 1");

  expect(JSON.parse(stderr.join(""))).toMatchObject({
    error: { code: "DAEMON_UPDATE_REQUIRED" },
  });
  expect(addHost).not.toHaveBeenCalled();
  expect(updateHost).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

it("rejects a malformed token file without disclosing its contents", async () => {
  const invalidToken = "secret-that-must-not-appear-in-output";
  await writeFile(tokenFile, invalidToken);
  await expect(
    run(["accept-reverse", "srv_mac", "--token-file", tokenFile, "--json"]),
  ).rejects.toThrow("CLI exited with status 1");

  expect(JSON.parse(stderr.join(""))).toMatchObject({
    error: { code: "INVALID_REVERSE_TOKEN" },
  });
  expect(addHost).not.toHaveBeenCalled();
  expect(stderr.join("")).not.toContain(invalidToken);
});

it("requires valid explicit permission grants before changing reverse access", async () => {
  await expect(
    run(["enable-reverse", "hst_bakery", "--token-file", tokenFile, "--json"]),
  ).rejects.toThrow("CLI exited with status 1");
  await expect(
    run([
      "enable-reverse",
      "hst_bakery",
      "--token-file",
      tokenFile,
      "--permission",
      "made-up.permission",
      "--json",
    ]),
  ).rejects.toThrow("CLI exited with status 1");

  expect(stderr.map((line) => JSON.parse(line).error.code)).toEqual([
    "INVALID_REVERSE_PERMISSION",
    "INVALID_REVERSE_PERMISSION",
  ]);
  expect(updateHost).not.toHaveBeenCalled();
});
