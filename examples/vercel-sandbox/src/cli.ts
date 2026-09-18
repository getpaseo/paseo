#!/usr/bin/env node
import { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveVercelCredentials, resolveAgentKey, verifyAgentKey } from "./auth.js";
import {
  DEFAULT_IMAGE,
  DEFAULT_REGION,
  createSandbox,
  getSandbox,
  assertSandboxCanResume,
  resumeSandbox,
  stopSandbox,
  recordVerifiedSession,
  destroySandboxAndSnapshots,
} from "./lifecycle.js";
import {
  writeBootstrapToSandbox,
  runBootstrap,
  DEFAULT_PASEO_HOME,
  DEFAULT_WORKSPACE,
  DEFAULT_REPO_PATH,
} from "./bootstrap.js";
import { parsePairingOffer, startDaemonAndPair } from "./pairing.js";
import { providerDiagnostic, runFixtureTask, gitDiff } from "./agent.js";
import { redactText, resolveProvider, validateProviderSelection } from "./providers.js";
import { seedFixture } from "./fixture.js";
import { exportWorkspace, writeFileHashManifest } from "./export.js";
import { newState, loadState, saveState, addLog, trackProvision } from "./state.js";

const program = new Command();

program
  .name("paseo-sandbox")
  .description(
    "Launch a Paseo daemon and a selected coding agent inside a persistent Vercel Sandbox",
  )
  .version("0.1.0");

function requireSession(id: string) {
  const state = loadState(id);
  return state;
}

async function withSandbox<T>(
  id: string,
  fn: (
    sandbox: Awaited<ReturnType<typeof getSandbox>>,
    state: ReturnType<typeof requireSession>,
  ) => Promise<T>,
): Promise<T> {
  const state = requireSession(id);
  const creds = await resolveVercelCredentials({ team: state.teamId, project: state.projectId });
  const sandbox = await getSandbox(creds, state, false);
  return fn(sandbox, state);
}

program
  .command("doctor")
  .description("Check local prerequisites")
  .action(async () => {
    const checks: { id: string; ok: boolean; detail?: string }[] = [];
    try {
      const creds = await resolveVercelCredentials();
      checks.push({
        id: "vercel-oidc",
        ok: true,
        detail: `team=${creds.teamId} project=${creds.projectId}`,
      });
    } catch (e) {
      checks.push({ id: "vercel-oidc", ok: false, detail: String(e) });
    }
    try {
      await verifyAgentKey(resolveAgentKey());
      checks.push({ id: "ai-gateway-key", ok: true, detail: "accepted by AI Gateway" });
    } catch (e) {
      checks.push({ id: "ai-gateway-key", ok: false, detail: String(e) });
    }
    const failed = checks.filter((c) => !c.ok);
    for (const c of checks)
      console.log(`${c.ok ? "PASS" : "FAIL"} ${c.id}${c.detail ? ` ${c.detail}` : ""}`);
    if (failed.length) process.exitCode = 1;
  });

program
  .command("create")
  .description("Provision a new sandbox session")
  .option("--name <name>", "session name")
  .option("--team <team>", "Vercel team slug or ID")
  .option("--project <project>", "Vercel project slug or ID")
  .option("--region <region>", "Sandbox region", DEFAULT_REGION)
  .option("--image <image>", "Sandbox image", DEFAULT_IMAGE)
  .option("--repo <url>", "Git repository URL to clone")
  .option(
    "--provider <provider>",
    "agent provider: codex, claude, opencode, pi, or copilot",
    "codex",
  )
  .option("--model <model>", "slash-qualified AI Gateway model ID")
  .action(async (opts) => {
    const provider = resolveProvider(opts.provider);
    const agentModel = opts.model ?? provider.defaultModel;
    validateProviderSelection(provider.id, agentModel);
    const creds = await resolveVercelCredentials({ team: opts.team, project: opts.project });
    const state = newState({
      name: opts.name,
      region: opts.region,
      image: opts.image,
      teamId: creds.teamId,
      projectId: creds.projectId,
      agentProvider: provider.id,
      agentModel,
      repoUrl: opts.repo,
      workspacePath: DEFAULT_WORKSPACE,
      repoPath: DEFAULT_REPO_PATH,
      paseoHome: DEFAULT_PASEO_HOME,
    });
    saveState(state);
    addLog(state, "session created");
    saveState(state);
    console.log(JSON.stringify({ id: state.id, name: state.name }, null, 2));
  });

program
  .command("provision <id>")
  .description("Create the sandbox, install packages, and start the daemon")
  .action(async (id) => {
    const state = requireSession(id);
    validateProviderSelection(state.agentProvider, state.agentModel);
    // Validate credentials before creating billable resources.
    await verifyAgentKey(resolveAgentKey());
    const creds = await resolveVercelCredentials({ team: state.teamId, project: state.projectId });
    await trackProvision(state, async () => {
      state.phase = "creating";
      saveState(state);
      const sandbox = await createSandbox(creds, state);
      recordVerifiedSession(sandbox, state);
      state.phase = "created";
      state.sandboxStatus = sandbox.status;
      saveState(state);
      await writeBootstrapToSandbox(sandbox, state);
      state.phase = "bootstrapping";
      saveState(state);
      await runBootstrap(sandbox, state);
      const pairing = await startDaemonAndPair(sandbox, state);
      state.phase = "ready";
      state.pairingUrl = pairing.url;
      saveState(state);
      const diagnostic = await providerDiagnostic(sandbox, state);
      if (!diagnostic.ok) {
        throw new Error(
          redactText(`provider diagnostic failed: ${JSON.stringify(diagnostic.diagnostic)}`),
        );
      }
      state.lastError = undefined;
      saveState(state);
      console.log(
        JSON.stringify(
          { id: state.id, pairingUrl: pairing.url, serverId: pairing.serverId },
          null,
          2,
        ),
      );
    });
  });

program
  .command("connect <id>")
  .description("Return safe connection instructions, or reveal the pairing link explicitly")
  .option("--url", "print the private pairing link")
  .action(async (id, opts) => {
    const state = requireSession(id);
    if (!state.pairingUrl) throw new Error("session is not provisioned");
    console.log(
      opts.url
        ? state.pairingUrl
        : `PASEO_HOST="$(paseo-sandbox connect ${state.id} --url)" paseo ls`,
    );
  });

program.command("status <id>").action(async (id) => {
  const state = requireSession(id);
  const { pairingUrl, logs: _logs, lastError, ...summary } = state;
  console.log(
    JSON.stringify(
      { ...summary, hasPairing: Boolean(pairingUrl), hasError: Boolean(lastError) },
      null,
      2,
    ),
  );
});

program.command("stop <id>").action(async (id) => {
  const state = requireSession(id);
  const creds = await resolveVercelCredentials({ team: state.teamId, project: state.projectId });
  state.phase = "stopping";
  saveState(state);
  const sandbox = await getSandbox(creds, state, false);
  const snapshot = await stopSandbox(sandbox);
  if (snapshot) {
    if (!state.snapshotIds.includes(snapshot.id)) state.snapshotIds.push(snapshot.id);
    if (!state.snapshots.some((candidate) => candidate.id === snapshot.id))
      state.snapshots.push(snapshot);
  }
  state.phase = "stopped";
  state.sandboxStatus = "stopped";
  saveState(state);
  console.log(JSON.stringify({ snapshotId: snapshot?.id }, null, 2));
});

program.command("resume <id>").action(async (id) => {
  const state = requireSession(id);
  validateProviderSelection(state.agentProvider, state.agentModel);
  if (!state.pairingUrl) throw new Error("stored pairing offer is required before resume");
  const storedPairing = parsePairingOffer(state.pairingUrl, "stored pairing offer");
  const creds = await resolveVercelCredentials({ team: state.teamId, project: state.projectId });
  const sandbox = await getSandbox(creds, state, false);
  assertSandboxCanResume(sandbox);
  state.phase = "resuming";
  saveState(state);
  await resumeSandbox(sandbox);
  recordVerifiedSession(sandbox, state);
  // The VM session is new; the daemon process from the old session is gone.
  // Restart it. PASEO_HOME persists, so the daemon keeps its serverId and
  // keypair and the original pairing offer stays valid.
  const pairing = await startDaemonAndPair(sandbox, state);
  if (
    storedPairing.serverId !== pairing.serverId ||
    storedPairing.daemonPublicKeyB64 !== pairing.daemonPublicKeyB64
  ) {
    throw new Error("daemon identity changed across resume; refusing to reuse the session");
  }
  state.phase = "ready";
  state.sandboxStatus = "running";
  state.pairingUrl = pairing.url;
  saveState(state);
  console.log(JSON.stringify({ resumed: true, serverId: pairing.serverId }, null, 2));
});

program
  .command("run <id> <prompt>")
  .description("Run a task through the Paseo CLI on the sandbox")
  .action(async (id, prompt) => {
    await withSandbox(id, async (sandbox, state) => {
      validateProviderSelection(state.agentProvider, state.agentModel);
      const out = await runFixtureTask(sandbox, state, prompt);
      console.log(out);
    });
  });

program
  .command("seed <id>")
  .description("Write the synthetic fixture into the sandbox workspace and confirm its test fails")
  .action(async (id) => {
    await withSandbox(id, async (sandbox, state) => {
      await seedFixture(sandbox, state);
      console.log(JSON.stringify({ seeded: true, expectedFailure: true }, null, 2));
    });
  });

program
  .command("diff <id>")
  .description("Show git diff in the sandbox workspace")
  .action(async (id) => {
    await withSandbox(id, async (sandbox, state) => {
      console.log(await gitDiff(sandbox, state));
    });
  });

program
  .command("export <id>")
  .description("Export the workspace to a local directory")
  .requiredOption("--output <path>", "local output path")
  .action(async (id, opts) => {
    const output = resolve(opts.output);
    const manifestPath = `${output}.manifest.json`;
    if (existsSync(output)) throw new Error(`output exists: ${output}`);
    if (existsSync(manifestPath)) throw new Error(`manifest sidecar exists: ${manifestPath}`);
    await withSandbox(id, async (sandbox, state) => {
      await exportWorkspace(sandbox, state, output);
      const manifest = await writeFileHashManifest(output, manifestPath);
      console.log(
        JSON.stringify(
          { exported: output, manifest: manifestPath, files: Object.keys(manifest).length },
          null,
          2,
        ),
      );
    });
  });

program
  .command("destroy <id>")
  .description("Delete the sandbox and its snapshots, then verify absence")
  .action(async (id) => {
    const state = requireSession(id);
    const creds = await resolveVercelCredentials({ team: state.teamId, project: state.projectId });
    state.phase = "destroying";
    saveState(state);
    try {
      const deleted = await destroySandboxAndSnapshots(creds, state, saveState);
      state.phase = "destroyed";
      saveState(state);
      console.log(JSON.stringify({ destroyed: true, verified: true, snapshots: deleted }, null, 2));
    } catch (e) {
      state.phase = "failed";
      state.lastError = String(e);
      saveState(state);
      throw e;
    }
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
