import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AI_GATEWAY_API_KEY ||= "test-key";
const daemonKey = Buffer.alloc(32, 7).toString("base64");

function assertDoesNotLeak(error, secret, encoded) {
  assert.ok(!String(error).includes(secret));
  assert.ok(!String(error).includes(encoded));
}

function fakeSandbox({
  pairJson,
  statusJson = '{"localDaemon":"running"}',
  startExit = 0,
  pairExit = 0,
}) {
  const calls = [];
  const envs = [];
  return {
    calls,
    envs,
    async runCommand(params) {
      envs.push(params.env);
      const cmdline = Array.isArray(params.args) ? params.args.join(" ") : params.cmd;
      calls.push(cmdline);
      if (cmdline.includes("daemon pair")) {
        return {
          exitCode: pairExit,
          stdout: async () => pairJson,
          stderr: async () => "",
        };
      }
      return {
        exitCode: startExit,
        stdout: async () => statusJson,
        stderr: async () => "",
      };
    },
  };
}

const { parsePairingOffer, startDaemonAndPair } = await import("../dist/pairing.js");

const state = {
  id: "x",
  name: "x",
  createdAt: "",
  updatedAt: "",
  phase: "ready",
  sandboxName: "s",
  region: "iad1",
  image: "i",
  teamId: "t",
  projectId: "p",
  owner: "o",
  paseoHome: "/vercel/paseo-home",
  workspacePath: "/vercel/workspace",
  repoPath: "/vercel/workspace/repo",
  agentProvider: "codex",
  agentModel: "openai/gpt-6-astra",
  sessionIds: [],
  snapshotIds: [],
  logs: [],
};

function offerUrl(serverId, key = daemonKey) {
  const payload = Buffer.from(
    JSON.stringify({
      v: 2,
      serverId,
      daemonPublicKeyB64: key,
      relay: { endpoint: "relay.example:443", useTls: true },
    }),
  ).toString("base64url");
  return `https://app.paseo.sh/#offer=${payload}`;
}

test("startDaemonAndPair extracts serverId and key from offer URL", async () => {
  const url = offerUrl("srv_123");
  const sb = fakeSandbox({ pairJson: JSON.stringify({ url }) });
  const result = await startDaemonAndPair(sb, state);
  assert.equal(result.url, url);
  assert.equal(result.serverId, "srv_123");
  assert.equal(result.daemonPublicKeyB64, daemonKey);
  // regression: the gateway key must travel via env, never command args
  assert.ok(
    !sb.calls.some((c) => c.includes(process.env.AI_GATEWAY_API_KEY)),
    "gateway key leaked into command args",
  );
  const env = sb.envs[0];
  assert.equal(env.AI_GATEWAY_API_KEY, process.env.AI_GATEWAY_API_KEY);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, process.env.AI_GATEWAY_API_KEY);
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://ai-gateway.vercel.sh/claude-code");
  assert.equal(env.COPILOT_PROVIDER_API_KEY, process.env.AI_GATEWAY_API_KEY);
  assert.equal(env.COPILOT_PROVIDER_BASE_URL, "https://ai-gateway.vercel.sh/coding-agent/v1");
  assert.equal(env.COPILOT_MODEL, "openai/gpt-6-astra");
  assert.ok(sb.calls[0].includes('node "$HOME/.paseo-sandbox/configure-providers.js"'));
  assert.match(sb.calls[0], /if ! node "\$HOME\/\.paseo-sandbox\/configure-providers\.js"; then/);
  assert.match(sb.calls[0], /refusing to start daemon/);
  assert.match(sb.calls[0], /export CLAUDE_CONFIG_DIR="\$HOME\/\.claude"/);
  assert.match(sb.calls[0], /export XDG_DATA_HOME="\$HOME\/\.local\/share"/);
  assert.match(sb.calls[0], /export OPENCODE_CONFIG_DIR="\$HOME\/\.config\/opencode"/);
  assert.match(sb.calls[0], /export PI_CODING_AGENT_DIR="\$HOME\/\.pi\/agent"/);
  assert.match(sb.calls[0], /export OPENCODE_AUTH_CONTENT=/);
  assert.ok(sb.calls[0].includes('export PATH="$HOME/.npm-global/bin:$PATH"'));
});

test("credential refresh failure gates daemon start and pairing", async () => {
  const calls = [];
  const sandbox = {
    async runCommand(options) {
      const command = options.args.join(" ");
      calls.push(command);
      if (command.includes("configure-providers.js")) {
        return {
          exitCode: 1,
          stdout: async () => "",
          stderr: async () => "simulated refresh failure",
        };
      }
      return {
        exitCode: 0,
        stdout: async () => '{"localDaemon":"running"}',
        stderr: async () => "",
      };
    },
  };
  await assert.rejects(
    () => startDaemonAndPair(sandbox, state),
    /daemon failed to start[\s\S]*simulated refresh failure/,
  );
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes("daemon pair"));
});

test("startDaemonAndPair refreshes rotated credentials on fresh start and resume", async () => {
  const url = offerUrl("srv_rotate");
  const calls = [];
  const sandbox = {
    async runCommand(options) {
      calls.push(options);
      const command = options.args.join(" ");
      return {
        exitCode: 0,
        stdout: async () =>
          command.includes("daemon pair") ? JSON.stringify({ url }) : '{"localDaemon":"running"}',
        stderr: async () => "",
      };
    },
  };
  process.env.AI_GATEWAY_API_KEY = "first-rotation-key";
  await startDaemonAndPair(sandbox, state);
  process.env.AI_GATEWAY_API_KEY = "second-rotation-key";
  await startDaemonAndPair(sandbox, state);
  assert.equal(calls[0].env.AI_GATEWAY_API_KEY, "first-rotation-key");
  assert.equal(calls[2].env.AI_GATEWAY_API_KEY, "second-rotation-key");
  assert.equal(calls[2].env.ANTHROPIC_AUTH_TOKEN, "second-rotation-key");
  assert.ok(!JSON.stringify(calls.map((call) => call.args)).includes("first-rotation-key"));
  assert.ok(!JSON.stringify(calls.map((call) => call.args)).includes("second-rotation-key"));
});

test("missing gateway key fails before a daemon command", async () => {
  const previous = process.env.AI_GATEWAY_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  const sandbox = {
    async runCommand() {
      throw new Error("must not start");
    },
  };
  try {
    await assert.rejects(
      () => startDaemonAndPair(sandbox, state),
      /AI_GATEWAY_API_KEY is required/,
    );
  } finally {
    if (previous !== undefined) process.env.AI_GATEWAY_API_KEY = previous;
  }
});

test("startDaemonAndPair fails when daemon start fails", async () => {
  const sb = fakeSandbox({ pairJson: "{}", startExit: 1 });
  await assert.rejects(() => startDaemonAndPair(sb, state), /daemon failed to start/);
});

test("startDaemonAndPair fails when status reports a stopped daemon", async () => {
  const sb = fakeSandbox({ pairJson: "{}", statusJson: '{\n  "localDaemon": "stopped"\n}' });
  await assert.rejects(() => startDaemonAndPair(sb, state), /daemon failed to start/);
});

test("startDaemonAndPair fails when pairing output is not JSON", async () => {
  const sb = fakeSandbox({ pairJson: "not json" });
  await assert.rejects(() => startDaemonAndPair(sb, state), /invalid JSON/);
});

test("startDaemonAndPair fails when pairing has no url", async () => {
  const sb = fakeSandbox({ pairJson: JSON.stringify({}) });
  await assert.rejects(() => startDaemonAndPair(sb, state), /did not return a url/);
});

test("startDaemonAndPair fails when offer lacks serverId", async () => {
  const url = offerUrl(undefined);
  const sb = fakeSandbox({ pairJson: JSON.stringify({ url }) });
  await assert.rejects(() => startDaemonAndPair(sb, state), /invalid pairing offer/);
});

test("parsePairingOffer validates the pinned offer schema and key", () => {
  const offer = parsePairingOffer(offerUrl("srv_123"));
  assert.equal(offer.serverId, "srv_123");
  assert.equal(offer.daemonPublicKeyB64, daemonKey);
});

test("parsePairingOffer rejects malformed stored identity without leaking it", () => {
  const malformed = Buffer.from(
    JSON.stringify({
      v: 2,
      serverId: "",
      daemonPublicKeyB64: daemonKey,
      secret: "pairing-secret",
      relay: { endpoint: "relay.example:443" },
    }),
  ).toString("base64url");
  const url = `https://app.paseo.sh/#offer=${malformed}`;
  assert.throws(
    () => parsePairingOffer(url, "stored pairing offer"),
    /invalid stored pairing offer/i,
  );
  try {
    parsePairingOffer(url, "stored pairing offer");
  } catch (error) {
    assertDoesNotLeak(error, "pairing-secret", malformed);
  }
});

test("missing daemon home fails immediately before starting or polling a daemon", async () => {
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const missing = join(tmpdir(), "paseo-missing-" + randomUUID());
  const sandbox = {
    async runCommand(params) {
      try {
        const out = execFileSync(params.cmd, params.args, {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin", ...params.env },
          timeout: 2000,
        });
        return { exitCode: 0, stdout: async () => out, stderr: async () => "" };
      } catch (e) {
        if (e.signal)
          throw new Error("daemon startup timed out instead of rejecting missing state", {
            cause: e,
          });
        return {
          exitCode: e.status,
          stdout: async () => String(e.stdout ?? ""),
          stderr: async () => String(e.stderr ?? ""),
        };
      }
    },
  };
  await assert.rejects(
    () => startDaemonAndPair(sandbox, { ...state, paseoHome: missing }),
    /daemon failed to start[\s\S]*Paseo state directory is missing/,
  );
});
