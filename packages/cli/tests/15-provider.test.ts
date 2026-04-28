#!/usr/bin/env npx tsx

/**
 * Phase 15: Provider Command Tests
 *
 * Tests provider commands for listing providers and models.
 * Provider ls data is static, while provider models are fetched via daemon integration.
 * This test uses an isolated daemon to avoid coupling to a user's long-running daemon.
 *
 * Tests:
 * - provider --help shows subcommands
 * - provider ls lists all providers
 * - provider ls --json outputs valid JSON
 * - provider ls --quiet outputs provider names only
 * - provider models claude lists claude models
 * - provider models codex lists codex models
 * - provider models opencode lists opencode models
 * - provider models unknown fails with error
 * - provider models --json outputs valid JSON
 */

import assert from "node:assert";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/server";
import { createE2ETestContext } from "./helpers/test-daemon.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createE2ETestContext,
  createTempDirs,
  runPaseoCli,
  startTestDaemon,
} from "./helpers/test-daemon.ts";

const MANIFEST_PROVIDER_IDS_SORTED = AGENT_PROVIDER_DEFINITIONS.map((d) => d.id).sort();

console.log("=== Provider Commands ===\n");

interface ProviderModel {
  model: string;
  id: string;
  description?: string;
}

interface ProviderListRow {
  provider: string;
  label: string;
  status: string;
  enabled: string;
}

const EXPECTED_CLAUDE_MODELS = [
  {
    id: "claude-opus-4-7[1m]",
    model: "Opus 4.7 1M",
    descriptionFragment: "1M context window",
  },
  {
    id: "claude-opus-4-7",
    model: "Opus 4.7",
    descriptionFragment: "Latest release",
  },
  {
    id: "claude-opus-4-6[1m]",
    model: "Opus 4.6 1M",
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
    assert.strictEqual(result.exitCode, 0, "provider --help should exit 0");
    assert(result.stdout.includes("ls"), "help should mention ls");
    assert(result.stdout.includes("models"), "help should mention models");
    console.log("✓ provider --help shows subcommands\n");
  }

  // Test 2: provider ls lists all providers
  {
    console.log("Test 2: provider ls lists all providers");
    const result = await ctx.paseo(["provider", "ls"]);
    assert.strictEqual(result.exitCode, 0, "provider ls should exit 0");
    for (const id of AGENT_PROVIDER_DEFINITIONS) {
      assert(
        result.stdout.includes(id.id),
        `provider ls output should include manifest provider ${id.id}`,
      );
    }
    assert(result.stdout.includes("available"), "output should show available status");
    console.log("✓ provider ls lists all providers\n");
  }

  // Test 3: provider ls --json outputs valid JSON
  {
    console.log("Test 3: provider ls --json outputs valid JSON");
    const result = await ctx.paseo(["provider", "ls", "--json"]);
    assert.strictEqual(result.exitCode, 0, "should exit 0");
    const data = JSON.parse(result.stdout.trim());
    assert(Array.isArray(data), "output should be an array");
    assert.strictEqual(
      data.length,
      AGENT_PROVIDER_DEFINITIONS.length,
      "should list every manifest provider",
    );
    for (const def of AGENT_PROVIDER_DEFINITIONS) {
      assert(
        data.some((p: { provider: string }) => p.provider === def.id),
        `should include provider ${def.id}`,
      );
      assert(
        data.every((p: ProviderListRow) => p.enabled === "Enabled"),
        "enabled providers should report Enabled",
      );
    }
    console.log("✓ provider ls --json outputs valid JSON\n");
  }

  // Test 4: provider ls includes disabled providers
  {
    console.log("Test 4: provider ls includes disabled providers");
    const { paseoHome, workDir } = await createTempDirs();
    await writeFile(
      join(paseoHome, "config.json"),
      JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              claude: {
                enabled: false,
              },
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const disabledCtx = await startTestDaemon({ paseoHome, workDir, timeout: 120000 });
    try {
      const result = await runPaseoCli(disabledCtx, ["provider", "ls", "--json"]);
      assert.strictEqual(result.exitCode, 0, "provider ls should exit 0");
      const data = JSON.parse(result.stdout.trim()) as ProviderListRow[];
      const claude = data.find((p) => p.provider === "claude");
      assert(claude, "disabled claude provider should stay in provider ls");
      assert.strictEqual(claude.enabled, "Disabled", "disabled provider should report Disabled");

      const opencode = data.find((p) => p.provider === "opencode");
      assert(opencode, "enabled opencode provider should stay in provider ls");
      assert.strictEqual(opencode.enabled, "Enabled", "enabled provider should report Enabled");

      const modelsResult = await runPaseoCli(disabledCtx, ["provider", "models", "claude"]);
      assert.notStrictEqual(
        modelsResult.exitCode,
        0,
        "provider models should fail for disabled providers",
      );
      const output = modelsResult.stdout + modelsResult.stderr;
      assert(
        output.includes("Provider claude is disabled"),
        "provider models should surface the daemon disabled error",
      );
      assert(
        !output.includes("claude-sonnet"),
        "provider models should not print fallback models for disabled providers",
      );
    } finally {
      await disabledCtx.stop();
    }
    console.log("✓ provider ls includes disabled providers\n");
  }

  // Test 5: provider ls --quiet outputs provider names only
  {
    console.log("Test 5: provider ls --quiet outputs provider names only");
    const result = await ctx.paseo(["provider", "ls", "--quiet"]);
    assert.strictEqual(result.exitCode, 0, "should exit 0");
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    assert.strictEqual(
      lines.length,
      AGENT_PROVIDER_DEFINITIONS.length,
      "should have one line per manifest provider",
    );
    assert.deepStrictEqual([...lines].sort(), MANIFEST_PROVIDER_IDS_SORTED);
    console.log("✓ provider ls --quiet outputs provider names only\n");
  }

  // Test 6: provider models claude lists canonical model aliases
  {
    console.log("Test 6: provider models claude lists canonical model aliases");
    const data = await runProviderModelsJson("claude");
    assertClaudeModels(data);
    console.log("✓ provider models claude lists canonical model aliases\n");
  }

  // Test 7: provider models codex includes concrete codex model IDs
  {
    console.log("Test 7: provider models codex includes concrete codex model IDs");
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

  // Test 8: provider models opencode returns namespaced model IDs
  {
    console.log("Test 8: provider models opencode returns namespaced model IDs");
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
    const hasOpenRouterOpenAi = ids.some((id) => id.startsWith("openrouter/openai/"));
    if (!hasOpenRouterOpenAi) {
      console.log(
        "(note) opencode model list had no openrouter/openai/* entries in this environment\n",
      );
    }
    console.log("✓ provider models opencode returns namespaced model IDs\n");
  }

  // Test 7b: provider models cursor (best-effort; requires Cursor CLI auth on the machine)
  {
    console.log("Test 7b: provider models cursor (best-effort)");
    const result = await ctx.paseo(["provider", "models", "cursor", "--json"]);
    if (result.exitCode === 0) {
      const data = JSON.parse(result.stdout.trim()) as ProviderModel[];
      assert(data.length >= 1, "cursor model list should be non-empty when CLI is authenticated");
      const ids = data.map((m) => m.id);
      assert.strictEqual(new Set(ids).size, ids.length, "cursor model IDs should be unique");
    } else {
      console.log("(skipped) provider models cursor did not exit 0 — likely no `agent` auth\n");
    }
    console.log("✓ provider models cursor check completed\n");
  }

  // Test 8: provider models unknown fails with error
  {
    console.log("Test 9: provider models unknown fails with error");
    const result = await ctx.paseo(["provider", "models", "unknown"]);
    assert.notStrictEqual(result.exitCode, 0, "should fail for unknown provider");
    const output = result.stdout + result.stderr;
    assert(
      output.toLowerCase().includes("unknown") || output.toLowerCase().includes("provider"),
      "error should mention unknown provider",
    );
    console.log("✓ provider models unknown fails with error\n");
  }

  // Test 10: provider models --json outputs valid JSON
  {
    console.log("Test 10: provider models --json outputs valid JSON");
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

  // Test 11: provider models --quiet outputs model IDs only
  {
    console.log("Test 11: provider models --quiet outputs model IDs only");
    assert(
      claudeModelIdsFromJson.length > 0,
      "claude model IDs should be captured from --json output",
    );
    const result = await ctx.paseo(["provider", "models", "claude", "--quiet"]);
    assert.strictEqual(result.exitCode, 0, "should exit 0");
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
      claudeModelsFromJson.some((m) => m.id === "claude-sonnet-4-6"),
      "captured --json output should include the current Claude everyday model id",
    );
    console.log("✓ provider models --quiet outputs model IDs only\n");
  }
} finally {
  await ctx.stop();
}

console.log("=== All provider tests passed ===");
