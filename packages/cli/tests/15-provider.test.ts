#!/usr/bin/env npx tsx

/**
 * Phase 15: Provider Command Tests
 *
 * Tests provider commands for configured Paseo Agent model providers and agent
 * provider model listing. This test uses an isolated daemon to avoid coupling to
 * a user's long-running daemon.
 *
 * Tests:
 * - provider --help shows subcommands
 * - provider ls on a fresh daemon prints an empty configured-provider table
 * - provider add stores an API-key model provider without network validation
 * - repeated provider add updates the same provider instance
 * - provider add rejects unknown catalog ids with known ids
 * - provider rm removes a configured model provider
 * - provider add uses catalog default models when present
 * - provider models claude lists claude models
 * - provider models codex lists codex models
 * - provider models opencode lists opencode models
 * - provider models unknown fails with error
 * - provider models --json outputs valid JSON
 */

import assert from "node:assert";
import { createE2ETestContext } from "./helpers/test-daemon.ts";

console.log("=== Provider Commands ===\n");

interface ProviderModel {
  model: string;
  id: string;
  description?: string;
}

interface ProviderListRow {
  name: string;
  providerType: string;
  label: string;
  auth: string;
  available: string;
  models: string;
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function assertExitCode(result: CliResult, expected: number, message: string): void {
  assert.strictEqual(result.exitCode, expected, `${message}\nstderr:\n${result.stderr}`);
}

function assertNonZeroExitCode(result: CliResult, message: string): void {
  assert.notStrictEqual(result.exitCode, 0, `${message}\nstderr:\n${result.stderr}`);
}

const EXPECTED_CLAUDE_MODELS = [
  {
    id: "claude-fable-5",
    model: "Fable 5",
    descriptionFragment: "Most powerful",
  },
  {
    id: "claude-opus-4-8[1m]",
    model: "Opus 4.8 1M",
    descriptionFragment: "1M context window",
  },
  {
    id: "claude-opus-4-8",
    model: "Opus 4.8",
    descriptionFragment: "Latest release",
  },
  {
    id: "claude-sonnet-5",
    model: "Sonnet 5",
    descriptionFragment: "Best for everyday tasks",
  },
  {
    id: "claude-opus-4-7[1m]",
    model: "Opus 4.7 1M",
    descriptionFragment: "1M context window",
  },
  {
    id: "claude-opus-4-7",
    model: "Opus 4.7",
    descriptionFragment: "Previous release",
  },
  {
    id: "claude-opus-4-6[1m]",
    model: "Opus 4.6 1M",
    descriptionFragment: "1M context window",
  },
  {
    id: "claude-sonnet-4-6[1m]",
    model: "Sonnet 4.6 1M",
    descriptionFragment: "1M context window",
  },
  {
    id: "claude-sonnet-4-6",
    model: "Sonnet 4.6",
    descriptionFragment: "Best for everyday tasks",
  },
  {
    id: "claude-opus-4-6",
    model: "Opus 4.6",
    descriptionFragment: "Most capable",
  },
  {
    id: "claude-haiku-4-5",
    model: "Haiku 4.5",
    descriptionFragment: "Fastest",
  },
] as const;

let claudeModelIdsFromJson: string[] = [];
let claudeModelsFromJson: ProviderModel[] = [];

const ctx = await createE2ETestContext({ timeout: 120000 });

async function runProviderModelsJson(provider: string): Promise<ProviderModel[]> {
  const transientNeedles = ["transport closed", "timed out", "timeout", "socket", "econn"];

  async function attemptRun(attempt: number): Promise<ProviderModel[]> {
    const result = await ctx.paseo(["provider", "models", provider, "--json"]);
    if (result.exitCode === 0) {
      return JSON.parse(result.stdout.trim()) as ProviderModel[];
    }

    const combined = `${result.stdout}\n${result.stderr}`;
    const normalized = combined.toLowerCase();
    const isTransient = transientNeedles.some((needle) => normalized.includes(needle));

    if (!isTransient || attempt === 3) {
      assert.fail(`provider models ${provider} should exit 0\n${combined}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    return attemptRun(attempt + 1);
  }

  return attemptRun(1);
}

function parseProviderListJson(stdout: string): ProviderListRow[] {
  const data = JSON.parse(stdout.trim()) as ProviderListRow[];
  assert(Array.isArray(data), "provider ls --json output should be an array");
  return data;
}

async function getProviderRows(): Promise<ProviderListRow[]> {
  const result = await ctx.paseo(["provider", "ls", "--json"]);
  assertExitCode(result, 0, "provider ls --json should exit 0");
  return parseProviderListJson(result.stdout);
}

function assertProviderTableHeader(stdout: string): void {
  for (const header of ["NAME", "TYPE", "LABEL", "AUTH", "AVAILABLE", "MODELS"]) {
    assert(stdout.includes(header), `provider ls table should include ${header}`);
  }
}

function assertClaudeModels(data: ProviderModel[]): void {
  assert.strictEqual(
    data.length,
    EXPECTED_CLAUDE_MODELS.length,
    "claude output should match the current catalog size",
  );

  const byId = new Map(data.map((model) => [model.id, model]));
  const ids = [...byId.keys()].sort();
  const expectedIds = EXPECTED_CLAUDE_MODELS.map((model) => model.id).sort();

  assert.strictEqual(byId.size, data.length, "claude model IDs should be unique");
  assert.deepStrictEqual(ids, expectedIds, "claude IDs should match the current catalog");

  for (const expectedModel of EXPECTED_CLAUDE_MODELS) {
    const actualModel = byId.get(expectedModel.id);
    assert(actualModel, `claude output should include ${expectedModel.id}`);
    assert.strictEqual(
      actualModel.model,
      expectedModel.model,
      `${expectedModel.id} should keep its display name`,
    );
    assert(
      (actualModel.description ?? "").includes(expectedModel.descriptionFragment),
      `${expectedModel.id} description should mention ${expectedModel.descriptionFragment}`,
    );
  }
}

try {
  // Test 1: provider --help shows subcommands
  {
    console.log("Test 1: provider --help shows subcommands");
    const result = await ctx.paseo(["provider", "--help"]);
    assertExitCode(result, 0, "provider --help should exit 0");
    assert(result.stdout.includes("ls"), "help should mention ls");
    assert(result.stdout.includes("add"), "help should mention add");
    assert(result.stdout.includes("rm"), "help should mention rm");
    assert(result.stdout.includes("models"), "help should mention models");
    console.log("✓ provider --help shows subcommands\n");
  }

  // Test 2: provider ls on a fresh daemon shows no configured providers
  {
    console.log("Test 2: provider ls on a fresh daemon shows no configured providers");
    const result = await ctx.paseo(["provider", "ls"]);
    assertExitCode(result, 0, "provider ls should exit 0");
    assertProviderTableHeader(result.stdout);
    assert(!result.stdout.includes("OpenRouter"), "fresh output should have no provider rows");

    const jsonResult = await ctx.paseo(["provider", "ls", "--json"]);
    assertExitCode(jsonResult, 0, "provider ls --json should exit 0");
    assert.deepStrictEqual(parseProviderListJson(jsonResult.stdout), []);
    console.log("✓ provider ls on a fresh daemon shows no configured providers\n");
  }

  // Test 3: provider add openrouter stores a dummy key without network validation
  {
    console.log("Test 3: provider add openrouter stores a dummy key without network validation");
    const result = await ctx.paseo(["provider", "add", "openrouter", "--api-key-stdin"], {
      stdin: "dummy-openrouter-key\n",
    });
    assertExitCode(result, 0, "provider add should exit 0");
    assert(result.stdout.includes("openrouter"), "add output should include the instance name");
    assert(result.stdout.includes("OpenRouter"), "add output should include the catalog label");
    assert(result.stdout.includes("Connected"), "add output should show connected auth state");
    assert(result.stdout.includes("yes"), "add output should show the provider as available");

    const rows = await getProviderRows();
    assert.strictEqual(rows.length, 1, "provider ls should show exactly one configured instance");
    assert.deepStrictEqual(rows[0], {
      name: "openrouter",
      providerType: "openrouter",
      label: "OpenRouter",
      auth: "Connected",
      available: "yes",
      models: "-",
    });
    console.log("✓ provider add openrouter stores a dummy key without network validation\n");
  }

  // Test 4: provider add is idempotent for the same instance name
  {
    console.log("Test 4: provider add is idempotent for the same instance name");
    const result = await ctx.paseo(["provider", "add", "openrouter", "--api-key-stdin"], {
      stdin: "dummy-openrouter-key-2\n",
    });
    assertExitCode(result, 0, "provider add should exit 0");

    const rows = await getProviderRows();
    assert.strictEqual(rows.length, 1, "re-running add should not create another instance");
    assert.strictEqual(rows[0]?.name, "openrouter");
    assert.strictEqual(rows[0]?.label, "OpenRouter");
    console.log("✓ provider add is idempotent for the same instance name\n");
  }

  // Test 5: provider add rejects unknown catalog ids with known ids
  {
    console.log("Test 5: provider add rejects unknown catalog ids with known ids");
    const result = await ctx.paseo(["provider", "add", "nonsense-id", "--api-key-stdin"], {
      stdin: "dummy-key\n",
    });
    assertNonZeroExitCode(result, "provider add should fail for unknown ids");
    const output = result.stdout + result.stderr;
    assert(output.includes("nonsense-id"), "error should mention the requested id");
    assert(output.includes("Known provider ids"), "error should mention known provider ids");
    assert(output.includes("openrouter"), "known ids should include openrouter");
    assert(output.includes("kimi"), "known ids should include kimi");
    console.log("✓ provider add rejects unknown catalog ids with known ids\n");
  }

  // Test 6: provider rm removes a configured provider
  {
    console.log("Test 6: provider rm removes a configured provider");
    const result = await ctx.paseo(["provider", "rm", "openrouter"]);
    assertExitCode(result, 0, "provider rm should exit 0");
    assert(result.stdout.includes("openrouter"), "rm output should include the instance name");
    assert(result.stdout.includes("yes"), "rm output should report removal");

    const rows = await getProviderRows();
    assert.deepStrictEqual(rows, [], "provider ls should be empty after removing openrouter");
    const table = await ctx.paseo(["provider", "ls"]);
    assertExitCode(table, 0, "provider ls should stay successful after removal");
    assertProviderTableHeader(table.stdout);
    console.log("✓ provider rm removes a configured provider\n");
  }

  // Test 7: provider add uses catalog default models when present
  {
    console.log("Test 7: provider add uses catalog default models when present");
    const result = await ctx.paseo(["provider", "add", "kimi", "--api-key-stdin"], {
      stdin: "dummy-kimi-key\n",
    });
    assertExitCode(result, 0, "provider add kimi should exit 0");
    assert(result.stdout.includes("kimi"), "add output should include the instance name");
    assert(result.stdout.includes("Kimi Coding Plan"), "add output should include the label");

    const rows = await getProviderRows();
    const kimi = rows.find((row) => row.name === "kimi");
    assert(kimi, "provider ls should include the kimi instance");
    assert.strictEqual(kimi.label, "Kimi Coding Plan");
    assert.strictEqual(kimi.auth, "Connected");
    assert.strictEqual(kimi.available, "yes");
    assert.notStrictEqual(kimi.models, "-", "kimi should expose catalog-derived default models");
    assert(
      kimi.models
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean).length > 0,
      "kimi should list at least one catalog-derived model id",
    );
    console.log("✓ provider add uses catalog default models when present\n");
  }

  // Test 8: provider models claude lists canonical model aliases
  {
    console.log("Test 8: provider models claude lists canonical model aliases");
    const data = await runProviderModelsJson("claude");
    assertClaudeModels(data);
    console.log("✓ provider models claude lists canonical model aliases\n");
  }

  // Test 9: provider models codex includes concrete codex model IDs
  {
    console.log("Test 9: provider models codex includes concrete codex model IDs");
    const data = await runProviderModelsJson("codex");
    assert(data.length >= 1, "codex model list should not be empty");
    const ids = data.map((m) => m.id);
    assert.strictEqual(new Set(ids).size, ids.length, "codex model IDs should be unique");
    assert(
      ids.every((id) => id.startsWith("gpt-")),
      "all codex model IDs should be from the gpt family",
    );
    assert(
      ids.some((id) => id.includes("codex")),
      "codex model list should include at least one codex-optimized model",
    );
    assert(
      data.every((m) => m.model && m.id && m.description),
      "every codex model should have model, id, and description fields",
    );
    console.log("✓ provider models codex includes concrete codex model IDs\n");
  }

  // Test 10: provider models opencode returns namespaced model IDs
  {
    console.log("Test 10: provider models opencode returns namespaced model IDs");
    const data = await runProviderModelsJson("opencode");
    assert(data.length >= 1, "opencode model list should not be empty");
    const ids = data.map((m) => m.id);
    assert(
      data.every((m) => m.id.includes("/")),
      "opencode model IDs should be provider-namespaced",
    );
    assert(
      ids.some((id) => id.startsWith("opencode/")),
      "opencode output should include at least one first-party opencode model",
    );
    assert(
      data.every((m) => m.model && m.id && m.description !== undefined),
      "every opencode model should have model, id, and description fields",
    );
    console.log("✓ provider models opencode returns namespaced model IDs\n");
  }

  // Test 11: provider models unknown fails with error
  {
    console.log("Test 11: provider models unknown fails with error");
    const result = await ctx.paseo(["provider", "models", "unknown"]);
    assertNonZeroExitCode(result, "should fail for unknown provider");
    const output = result.stdout + result.stderr;
    assert(
      output.toLowerCase().includes("unknown") || output.toLowerCase().includes("provider"),
      "error should mention unknown provider",
    );
    console.log("✓ provider models unknown fails with error\n");
  }

  // Test 12: provider models --json outputs valid JSON
  {
    console.log("Test 12: provider models --json outputs valid JSON");
    const data = await runProviderModelsJson("claude");
    assert(Array.isArray(data), "output should be an array");
    assert(
      data.every((m) => m.model && m.id),
      "each model should have name and id",
    );
    assertClaudeModels(data);
    claudeModelIdsFromJson = data.map((m) => m.id);
    claudeModelsFromJson = data;
    console.log("✓ provider models --json outputs valid JSON\n");
  }

  // Test 13: provider models --quiet outputs model IDs only
  {
    console.log("Test 13: provider models --quiet outputs model IDs only");
    assert(
      claudeModelIdsFromJson.length > 0,
      "claude model IDs should be captured from --json output",
    );
    const result = await ctx.paseo(["provider", "models", "claude", "--quiet"]);
    assertExitCode(result, 0, "provider models claude --quiet should exit 0");
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    assert.strictEqual(
      lines.length,
      EXPECTED_CLAUDE_MODELS.length,
      "should have one line per Claude catalog model",
    );
    assert.deepStrictEqual(
      [...lines].sort(),
      [...claudeModelIdsFromJson].sort(),
      "--quiet should print the same model IDs returned by --json",
    );
    assert.deepStrictEqual(
      [...lines].sort(),
      EXPECTED_CLAUDE_MODELS.map((model) => model.id).sort(),
      "--quiet should print the current Claude catalog IDs",
    );
    assert(
      claudeModelsFromJson.some((m) => m.id === "claude-sonnet-5"),
      "captured --json output should include the current Claude everyday model id",
    );
    console.log("✓ provider models --quiet outputs model IDs only\n");
  }
} finally {
  await ctx.stop();
}

console.log("=== All provider tests passed ===");
