import { test } from "node:test";
import assert from "node:assert/strict";

const { providerDiagnostic, runFixtureTask } = await import("../dist/agent.js");

const baseState = {
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
  sessionIds: [],
  snapshotIds: [],
  logs: [],
};

test("provider diagnostics use the selected Paseo provider API and redact secrets", async () => {
  const key = "diagnostic-secret";
  process.env.AI_GATEWAY_API_KEY = key;
  try {
    for (const provider of ["codex", "claude", "opencode", "pi", "copilot"]) {
      const commands = [];
      const sandbox = {
        async runCommand(...args) {
          commands.push(args);
          return {
            exitCode: 0,
            stdout: async () =>
              JSON.stringify({
                provider,
                diagnostic: `Agent: ${provider}\n  Executable: /opt/agent\n  Models: 3\n  Status: Ready\n  Detail: Bearer ${key}`,
                apiKey: key,
                nested: { token: key, detail: `token=${key}` },
              }),
            stderr: async () => "",
          };
        },
      };
      const result = await providerDiagnostic(sandbox, {
        ...baseState,
        agentProvider: provider,
        agentModel: "vendor/model",
      });
      assert.equal(result.provider, provider);
      assert.equal(result.ok, true);
      assert.ok(JSON.stringify(commands).includes(`paseo provider diagnostic ${provider} --json`));
      assert.ok(JSON.stringify(commands).includes("AI_GATEWAY_API_KEY"));
      assert.ok(JSON.stringify(commands).includes("CLAUDE_CONFIG_DIR"));
      assert.ok(JSON.stringify(commands).includes("XDG_DATA_HOME"));
      assert.ok(JSON.stringify(commands).includes("PI_CODING_AGENT_DIR"));
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(key));
      assert.ok(serialized.includes("[REDACTED]"));
    }
  } finally {
    delete process.env.AI_GATEWAY_API_KEY;
  }
});

test("ready diagnostics with no models are not treated as usable", async () => {
  process.env.AI_GATEWAY_API_KEY = "empty-catalog-key";
  try {
    const sandbox = {
      async runCommand() {
        return {
          exitCode: 0,
          stdout: async () =>
            JSON.stringify({
              provider: "opencode",
              diagnostic: "OpenCode\n  Executable: opencode\n  Models: 0\n  Status: Ready",
            }),
          stderr: async () => "",
        };
      },
    };
    const result = await providerDiagnostic(sandbox, {
      ...baseState,
      agentProvider: "opencode",
      agentModel: "anthropic/claude-sonnet-5",
    });
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result.diagnostic), /catalog is ready but empty/);
  } finally {
    delete process.env.AI_GATEWAY_API_KEY;
  }
});

test("missing credentials produce an actionable diagnostic without running a command", async () => {
  const previous = process.env.AI_GATEWAY_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  try {
    const sandbox = {
      async runCommand() {
        throw new Error("must not run");
      },
    };
    const result = await providerDiagnostic(sandbox, {
      ...baseState,
      agentProvider: "pi",
      agentModel: "anthropic/claude-sonnet-5",
    });
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result.diagnostic), /AI_GATEWAY_API_KEY is required/);
  } finally {
    if (previous !== undefined) process.env.AI_GATEWAY_API_KEY = previous;
  }
});

test("failed diagnostics remain actionable and redacted", async () => {
  const key = "failed-diagnostic-secret";
  process.env.AI_GATEWAY_API_KEY = key;
  try {
    const sandbox = {
      async runCommand() {
        return {
          exitCode: 1,
          stdout: async () => `not-json ${key}`,
          stderr: async () => `agent failed ${key}; rerun provision`,
        };
      },
    };
    const result = await providerDiagnostic(sandbox, {
      ...baseState,
      agentProvider: "claude",
      agentModel: "anthropic/claude-sonnet-5",
    });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(key));
    assert.match(JSON.stringify(result), /rerun provision/);
  } finally {
    delete process.env.AI_GATEWAY_API_KEY;
  }
});

const fixtureCommands = [
  ["codex", "paseo run --provider 'codex' --model 'vendor/model' --mode full-access 'fix it'"],
  [
    "claude",
    "paseo run --provider 'claude' --model 'vendor/model' --mode bypassPermissions 'fix it'",
  ],
  [
    "opencode",
    "paseo run --provider 'opencode' --model 'vercel/vendor/model' --mode full-access 'fix it'",
  ],
  ["pi", "paseo run --provider 'pi' --model 'vercel-ai-gateway/vendor/model' 'fix it'"],
  ["copilot", "paseo run --provider 'copilot' --model 'vendor/model' --mode allow-all 'fix it'"],
];

for (const [provider, expected] of fixtureCommands) {
  test(`runFixtureTask maps ${provider} to its Paseo model and mode`, async () => {
    let command;
    const sandbox = {
      async runCommand(...args) {
        command = args;
        return { exitCode: 0, stdout: async () => "done", stderr: async () => "" };
      },
    };
    const state = { ...baseState, agentProvider: provider, agentModel: "vendor/model" };
    assert.equal(await runFixtureTask(sandbox, state, "fix it"), "done");
    assert.equal(command[0], "bash");
    assert.equal(command[1][0], "-lc");
    const script = command[1][1];
    assert.equal(script.slice(script.lastIndexOf("paseo run")), expected);
    assert.equal(
      state.agentModel,
      "vendor/model",
      "Gateway model in session state must stay unchanged",
    );
  });
}
