// Real billable journey; importing this module never provisions resources.
// Set per-run PASEO_SANDBOX_STATE_DIR and PASEO_TEST_RECEIPTS_DIR.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createPaseoClient } from "@getpaseo/client";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import {
  buildRelayWebSocketUrl,
  shouldUseTlsForDefaultHostedRelay,
} from "@getpaseo/protocol/daemon-endpoints";
import {
  atomicJson,
  fileHash,
  sanitize,
  hash,
  waitUntil,
  conversationEvidence,
  assertContinuity,
  verifyExport,
  assertInterrupted,
  stageOrder,
  cleanupAll,
  waitForUiGate,
  assertDisjointDirectories,
} from "./live-support.mjs";

import {
  cleanupLedger,
  discoverCleanup,
  hasCleanupProvenance,
  cleanupFromLedger,
} from "./live-cleanup.mjs";

const exec = promisify(execFile);
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const quote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;

export async function assertProviderUnavailable(sandbox, state) {
  const { providerDiagnostic } = await import("../dist/agent.js");
  const diagnostic = await providerDiagnostic(sandbox, state);
  assert.equal(diagnostic.ok, false, "Missing provider binary must fail readiness");
}

// oxlint-disable-next-line complexity -- This is one sequential live lifecycle with cleanup.
export async function main(argv = process.argv.slice(2)) {
  const stage = argv[0] ?? "all";
  assert.ok(stage === "all" || stageOrder.includes(stage), "Unknown live stage");
  const sessionAt = argv.indexOf("--session");
  let sessionId = sessionAt >= 0 ? argv[sessionAt + 1] : null;
  const keep = argv.includes("--keep");
  const stateDir = process.env.PASEO_SANDBOX_STATE_DIR;
  const receiptsDir = process.env.PASEO_TEST_RECEIPTS_DIR;
  const uiGate = process.env.PASEO_TEST_UI_GATE_FILE;
  if (uiGate)
    assert.ok(
      isAbsolute(uiGate) && !existsSync(uiGate),
      "UI gate must be an absolute, not-yet-created file",
    );
  assert.ok(stateDir && isAbsolute(stateDir), "Set an absolute per-run PASEO_SANDBOX_STATE_DIR");
  assert.ok(
    receiptsDir && isAbsolute(receiptsDir),
    "Set an absolute per-run PASEO_TEST_RECEIPTS_DIR",
  );
  assertDisjointDirectories(stateDir, receiptsDir);
  mkdirSync(receiptsDir, { recursive: true, mode: 0o700 });
  const { stateDirectory, statePath, loadState } = await import("../dist/state.js");
  assert.equal(
    resolve(stateDirectory()),
    resolve(stateDir, "sessions"),
    "Build the state-directory override before live verification",
  );
  const { resolveVercelCredentials } = await import("../dist/auth.js");
  const lifecycle = await import("../dist/lifecycle.js");
  const { getSandbox, isNotFound } = lifecycle;
  const journalPath = join(receiptsDir, "journey.json");
  const journal = existsSync(journalPath)
    ? JSON.parse(readFileSync(journalPath, "utf8"))
    : { runId: randomUUID(), owned: [], conversation: null, word: randomUUID() };
  assert.ok(Array.isArray(journal.owned));
  if (sessionId)
    assert.ok(
      journal.owned.some((item) => item.id === sessionId),
      "Session must belong to this run journal",
    );
  if (stage === "all")
    assert.ok(!sessionId && !journal.sessionId, "all requires a fresh run directory");
  const results = [];
  let cleanupFailed = false;
  const resultsPath = join(receiptsDir, `${stage}-${Date.now()}.json`);
  const secrets = Object.entries(process.env)
    .filter(([key, value]) => /KEY|TOKEN|PASSWORD|SECRET/.test(key) && value)
    .map(([, value]) => value);
  const abort = new AbortController();
  const onSignal = () => abort.abort(new Error("Live verification interrupted"));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let journalHash = fileHash(journalPath);
  const checkpoint = () => {
    atomicJson(journalPath, journal, journalHash);
    journalHash = fileHash(journalPath);
  };
  const rememberOffer = (url) => {
    if (url) {
      secrets.push(url);
      const part = new URL(url).hash.slice(7);
      if (part) secrets.push(part);
    }
    return url;
  };
  function record(step, details = {}) {
    const safe = sanitize({ step, at: new Date().toISOString(), ok: true, ...details }, secrets);
    for (const key of ["stdout", "stderr"]) if (safe[key]) safe[key] = safe[key].slice(0, 4000);
    results.push(safe);
    atomicJson(resultsPath, results);
    console.log(`${safe.ok ? "PASS" : "FAIL"} ${step}`);
  }
  const commandEnv = {
    ...process.env,
    PASEO_SANDBOX_STATE_DIR: stateDir,
    PASEO_HOME: join(stateDir, "external-client"),
  };
  delete commandEnv.PASEO_HOST;
  async function command(file, args, timeout = 300_000, extraEnv = {}, cleanup = false) {
    const started = Date.now();
    try {
      const output = await exec(file, args, {
        env: { ...commandEnv, ...extraEnv },
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        signal: cleanup ? undefined : abort.signal,
      });
      return sanitize({ ok: true, elapsedMs: Date.now() - started, ...output }, secrets);
    } catch (error) {
      return sanitize(
        {
          ok: false,
          elapsedMs: Date.now() - started,
          stdout: String(error.stdout ?? ""),
          stderr: String(error.stderr ?? error.message),
          code: error.code,
          signal: error.signal,
        },
        secrets,
      );
    }
  }
  const launcher = (args, timeout, env, cleanup) =>
    command(process.execPath, [join(root, "dist/cli.js"), ...args], timeout, env, cleanup);
  const client = (args, url = loadState(sessionId).pairingUrl, timeout = 660_000) =>
    command("npx", ["-y", "@getpaseo/cli@0.8.0", ...args], timeout, {
      PASEO_HOST: rememberOffer(url),
    });
  async function requireCommand(label, promise) {
    const outcome = await promise;
    record(label, outcome);
    assert.ok(outcome.ok, `${label} failed: ${outcome.stderr}`);
    return outcome;
  }
  function ownState(id, state = loadState(id)) {
    const owned = journal.owned.find((item) => item.id === id);
    assert.ok(owned, "Refusing a resource outside this run");
    for (const key of ["id", "name", "owner", "sandboxName", "teamId", "projectId"])
      assert.equal(state[key], owned[key], `Owned ${key} changed`);
    rememberOffer(state.pairingUrl);
    return state;
  }
  function patchState(id, patch) {
    const path = statePath(id);
    const bytes = readFileSync(path);
    const state = ownState(id, JSON.parse(bytes));
    atomicJson(path, { ...state, ...patch }, hash(bytes));
  }
  async function sandboxFor(id, running = true) {
    const state = ownState(id);
    const creds = await resolveVercelCredentials({ team: state.teamId, project: state.projectId });
    const sandbox = await getSandbox(creds, state, false);
    assert.equal(sandbox.tags?.owner, state.owner, "Sandbox ownership mismatch");
    assert.equal(sandbox.tags?.paseoSandbox, state.name, "Sandbox name tag mismatch");
    if (running)
      assert.equal(sandbox.status, "running", "Observation must not auto-resume a stopped Sandbox");
    return sandbox;
  }
  async function remote(id, cmd, args = [], cwd, timeoutMs = 60_000) {
    const sandbox = await sandboxFor(id);
    const result = await sandbox.runCommand({ cmd, args, cwd, timeoutMs });
    const output = sanitize(
      {
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: await result.stdout(),
        stderr: await result.stderr(),
      },
      secrets,
    );
    assert.ok(output.ok, `Remote observation failed: ${output.stderr}`);
    return output.stdout;
  }
  const remoteJson = async (id, source, args = []) =>
    JSON.parse(await remote(id, "node", ["-e", source, ...args]));
  const bootId = (id) =>
    remote(id, "cat", ["/proc/sys/kernel/random/boot_id"]).then((value) => value.trim());
  async function create(label) {
    const output = await requireCommand(
      `${label}.create`,
      launcher(["create", "--name", `paseo-live-${journal.runId}-${label}`]),
    );
    const { id } = JSON.parse(output.stdout);
    const state = loadState(id);
    assert.ok(id && state.name === `paseo-live-${journal.runId}-${label}`);
    const owned = {
      id,
      name: state.name,
      owner: state.owner,
      sandboxName: state.sandboxName,
      teamId: state.teamId,
      projectId: state.projectId,
    };
    journal.owned.push(owned);
    cleanupLedger(receiptsDir, owned, checkpoint).persist({
      ...owned,
      sessionIds: [],
      snapshots: [],
    });
    return id;
  }
  async function destroy(id) {
    const owned = journal.owned.find((item) => item.id === id);
    assert.ok(owned, "Refusing cleanup outside this run");
    if (owned.cleanupComplete) return;
    const ledger = cleanupLedger(receiptsDir, owned, checkpoint);
    const creds = await resolveVercelCredentials({ team: owned.teamId, project: owned.projectId });
    const verifiedState = await discoverCleanup(creds, ledger, lifecycle);
    let state;
    try {
      state = ownState(id);
    } catch {
      /* Preserve missing/corrupt state and use verified cleanup evidence. */
    }
    if (!state || !hasCleanupProvenance(state, verifiedState)) {
      const snapshots = await cleanupFromLedger(creds, ledger, lifecycle);
      owned.cleanupComplete = true;
      checkpoint();
      record("cleanup.owned-resource-from-checkpoint", {
        sessionId: id,
        snapshots,
        localStatePreserved: true,
      });
      return;
    }
    const output = await launcher(["destroy", id], 300_000, {}, true);
    let verified = false;
    if (output.ok) {
      const data = JSON.parse(output.stdout);
      verified =
        data.destroyed === true && data.verified === true && loadState(id).phase === "destroyed";
    }
    if (output.ok && verified) {
      owned.cleanupComplete = true;
      checkpoint();
    }
    record("cleanup.owned-resource", { ...output, ok: output.ok && verified, sessionId: id });
    assert.ok(output.ok && verified, "Owned Sandbox/snapshot absence was not verified");
  }
  async function observeConversation() {
    assert.ok(journal.agentId, "Run fixture-edit first");
    const offer = parseConnectionOfferFromUrl(rememberOffer(ownState(sessionId).pairingUrl));
    assert.ok(offer, "Missing pairing offer");
    const sdk = createPaseoClient({
      url: buildRelayWebSocketUrl({
        endpoint: offer.relay.endpoint,
        serverId: offer.serverId,
        role: "client",
        useTls: offer.relay.useTls ?? shouldUseTlsForDefaultHostedRelay(offer.relay.endpoint),
      }),
      e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
      reconnect: { enabled: false },
      connectTimeoutMs: 20_000,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    try {
      await sdk.connect();
      const agent = sdk.agents.ref(journal.agentId);
      assert.ok(await agent.refresh(), "Existing agent was not restored");
      const timeline = await agent.timeline.refetch({
        direction: "tail",
        limit: 0,
        projection: "projected",
      });
      return conversationEvidence(agent.current(), timeline);
    } finally {
      await sdk.close();
    }
  }
  async function rememberConversation(label, isFollowup = false) {
    const evidence = await observeConversation();
    record(`${label}.observed`, evidence);
    if (journal.conversation) assertContinuity(journal.conversation, evidence, isFollowup);
    assert.equal(evidence.status, "idle", "Agent did not finish successfully");
    assert.ok(
      evidence.userMessages > 0 && evidence.assistantMessages > 0 && evidence.toolCalls > 0,
      "Missing tool-using conversation",
    );
    journal.conversation = evidence;
    checkpoint();
    record(label, evidence);
    return evidence;
  }
  async function followup(label, filename) {
    const prompt = `Continue this same conversation. Create ${filename} in the repo root containing exactly the journey word from my first message followed by a newline. Do not infer it from files. Run npm test. Change no other files.`;
    const out = await requireCommand(
      `${label}.send-existing`,
      client(["send", journal.agentId, prompt, "--json"]),
    );
    const sent = JSON.parse(out.stdout);
    assert.equal(sent.agentId, journal.agentId);
    assert.equal(sent.status, "completed", "Send exited without a completed turn");
    const state = ownState(sessionId);
    assert.equal(
      await remote(sessionId, "cat", [join(state.repoPath, filename)]),
      `${journal.word}\n`,
      "Conversation recall or follow-up file failed",
    );
    await remote(sessionId, "npm", ["test"], state.repoPath);
    await rememberConversation(`${label}.thread-history`, true);
  }
  async function exportChecked(label) {
    const directory = join(receiptsDir, `${label}-${randomUUID()}`);
    const output = await requireCommand(
      label,
      launcher(["export", sessionId, "--output", directory]),
    );
    const exported = JSON.parse(output.stdout);
    assert.equal(exported.exported, directory);
    assert.equal(exported.manifest, `${directory}.manifest.json`);
    const manifest = JSON.parse(readFileSync(exported.manifest, "utf8"));
    record(`${label}.local-remote-hashes`, verifyExport(directory, manifest));
    return manifest;
  }
  async function stopResume(label) {
    const beforeBoot = await bootId(sessionId);
    const stopped = await requireCommand(`${label}.stop`, launcher(["stop", sessionId]));
    const snapshotId = JSON.parse(stopped.stdout).snapshotId;
    assert.ok(snapshotId, "Stop did not produce a snapshot");
    assert.equal((await sandboxFor(sessionId, false)).status, "stopped");
    await requireCommand(`${label}.resume`, launcher(["resume", sessionId], 660_000));
    const sandbox = await sandboxFor(sessionId);
    assert.equal(sandbox.sourceSnapshotId, snapshotId, "Resume used a different snapshot");
    const afterBoot = await bootId(sessionId);
    assert.notEqual(afterBoot, beforeBoot);
    record(`${label}.new-boot-from-snapshot`, { beforeBoot, afterBoot, snapshotId });
    return { beforeBoot, afterBoot };
  }
  async function provisionAuth() {
    assert.ok(!sessionId, "Provision needs a new session");
    sessionId = await create("primary");
    journal.sessionId = sessionId;
    checkpoint();
    await requireCommand("provision", launcher(["provision", sessionId], 900_000));
    const output = await requireCommand(
      "external-client.list",
      client(["ls", "-a", "-g", "--json"]),
    );
    assert.ok(Array.isArray(JSON.parse(output.stdout)), "Invalid agent directory");
    record("provision.boot", { bootId: await bootId(sessionId) });
  }
  async function fixtureEdit() {
    await requireCommand("fixture.seed-expected-failure", launcher(["seed", sessionId]));
    const state = ownState(sessionId);
    const prompt = `Remember the journey word ${journal.word} in this conversation; do not write it to disk. The npm test suite fails. Inspect the repository, fix the bug and run npm test. Change only src/ and test/.`;
    const result = await requireCommand(
      "external-client.first-code-edit",
      client([
        "run",
        "--cwd",
        state.repoPath,
        "--provider",
        "codex",
        "--mode",
        "full-access",
        "--wait-timeout",
        "8m",
        "--json",
        prompt,
      ]),
    );
    const data = JSON.parse(result.stdout);
    assert.ok(data.agentId);
    journal.agentId = data.agentId;
    checkpoint();
    assert.equal(data.status, "completed", "First turn did not complete");
    await remote(sessionId, "npm", ["test"], state.repoPath);
    const diff = await requireCommand("fixture.diff", launcher(["diff", sessionId]));
    assert.match(diff.stdout, /return a \+ b/);
    const changed = await remote(
      sessionId,
      "git",
      ["diff", "--cached", "--name-only", "-z"],
      state.repoPath,
    );
    const paths = changed.split("\0").filter(Boolean);
    assert.ok(
      paths.length > 0 && paths.every((path) => /^(src|test)\//.test(path)),
      "Out-of-scope fixture changes",
    );
    await rememberConversation("fixture.provider-thread-and-history");
  }
  async function reconnect() {
    const output = await requireCommand(
      "reconnect.external-list",
      client(["ls", "-a", "-g", "--json"]),
    );
    assert.ok(
      JSON.parse(output.stdout).some((agent) => agent.id === journal.agentId),
      "Original agent missing",
    );
    await rememberConversation("reconnect.retained-history");
    await followup("reconnect", "RECONNECT.md");
  }
  async function recovery() {
    await rememberConversation("recovery.before");
    const before = await exportChecked("before-resume");
    await stopResume("recovery");
    const after = await exportChecked("after-resume");
    assert.deepEqual(after, before, "Workspace bytes changed during recovery");
    await rememberConversation("recovery.same-provider-history");
    await followup("recovery", "RESUMED.md");
    if (uiGate) {
      await waitForUiGate(uiGate, sessionId, record, { intervalMs: 1000, signal: abort.signal });
      await rememberConversation("after-ui.same-provider-history");
    }
  }
  async function interruption() {
    const control = `/vercel/paseo-live-${journal.runId}`;
    const script = join(control, "probe.mjs");
    const nonce = randomUUID();
    const program = `import fs from 'node:fs';
import path from 'node:path';
const dir=path.dirname(process.argv[1]),nonce=process.argv[2];
const initial={nonce,pid:process.pid,bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};
fs.appendFileSync(path.join(dir,'starts.jsonl'),JSON.stringify(initial)+'\\n');
let seq=0;
function beat(){fs.writeFileSync(path.join(dir,'heartbeat.tmp'),JSON.stringify({...initial,seq:++seq}));fs.renameSync(path.join(dir,'heartbeat.tmp'),path.join(dir,'heartbeat.json'));}
beat();const timer=setInterval(beat,500);setTimeout(()=>{clearInterval(timer);fs.writeFileSync(path.join(dir,'done'),'finished');},300000);`;
    const sandbox = await sandboxFor(sessionId);
    await sandbox.mkDir(control);
    await sandbox.writeFiles([{ path: script, content: Buffer.from(program) }]);
    const observer = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),dir=process.argv[1],script=path.join(dir,'probe.mjs');
const read=(file)=>fs.existsSync(path.join(dir,file))?fs.readFileSync(path.join(dir,file),'utf8'):null;
const activePids=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).filter(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0').includes(script);}catch{return false;}}).map(Number);
console.log(JSON.stringify({scriptHash:crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex'),bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),marker:JSON.parse(read('heartbeat.json')||'null'),starts:(read('starts.jsonl')||'').trim().split('\\n').filter(Boolean).map(JSON.parse),activePids,done:read('done')!==null}));`;
    const sample = () => remoteJson(sessionId, observer, [control]);
    const prompt = `Run node ${quote(script)} ${quote(nonce)} as one foreground command and wait for it. Do not edit or restart the program; the controller will interrupt the VM. Do not run other commands.`;
    const send = await requireCommand(
      "interruption.send-existing",
      client(["send", journal.agentId, prompt, "--no-wait", "--json"]),
    );
    assert.equal(JSON.parse(send.stdout).status, "sent");
    const first = await waitUntil(
      sample,
      (value) => value.marker?.nonce === nonce && value.activePids.includes(value.marker.pid),
      { signal: abort.signal },
    );
    const before = await waitUntil(
      sample,
      (value) =>
        value.marker?.seq > first.marker.seq && value.activePids.includes(value.marker.pid),
      { signal: abort.signal },
    );
    assert.equal(before.scriptHash, hash(program));
    assert.equal(before.marker.bootId, before.bootId);
    assert.equal(before.starts.length, 1);
    assert.equal(before.done, false);
    assert.equal(
      (await observeConversation()).status,
      "running",
      "No active agent turn to interrupt",
    );
    record("interruption.started-and-heartbeating", {
      pid: before.marker.pid,
      bootId: before.bootId,
      firstSeq: first.marker.seq,
      observedSeq: before.marker.seq,
    });
    await stopResume("interruption");
    // Stop may snapshot a few more heartbeats than the last pre-stop observation.
    const frozen = await sample();
    assert.ok(frozen.marker?.seq >= before.marker.seq);
    const baseline = { ...before, marker: frozen.marker };
    assertInterrupted(baseline, frozen);
    const until = Date.now() + 15_000;
    let samples = 0;
    do {
      assertInterrupted(baseline, await sample());
      samples++;
      await delay(1000, undefined, { signal: abort.signal });
    } while (Date.now() < until);
    const settled = await waitUntil(
      observeConversation,
      (value) => ["idle", "error", "closed"].includes(value.status),
      { signal: abort.signal },
    );
    assertContinuity(journal.conversation, settled);
    journal.conversation = settled;
    checkpoint();
    record("interruption.no-process-or-replay-observed", {
      samples,
      observationWindowMs: 15_000,
      status: settled.status,
      providerThreadId: settled.nativeHandle,
      frozenSeq: frozen.marker.seq,
    });
  }
  async function expectFailure(label, promise, pattern) {
    const outcome = await promise;
    const diagnostic = `${outcome.stdout}\n${outcome.stderr}`;
    const formatError = /Invalid pairing offer|Unexpected token|ZodError|schema validation/i.test(
      diagnostic,
    );
    const ok =
      !outcome.ok &&
      !outcome.signal &&
      pattern.test(diagnostic) &&
      (label !== "failure.wrong-identity" || !formatError);
    record(label, { ...outcome, ok });
    assert.ok(ok, `${label} did not produce the expected diagnostic`);
    return outcome;
  }
  async function failures() {
    const state = ownState(sessionId);
    const offer = parseConnectionOfferFromUrl(state.pairingUrl);
    assert.ok(offer);
    await expectFailure(
      "failure.malformed-offer",
      client(["ls", "--json"], "https://app.paseo.sh/#offer=not-json", 60_000),
      /Invalid pairing offer|Unexpected token|JSON/i,
    );
    const badIdentity = { ...offer, daemonPublicKeyB64: Buffer.alloc(32, 19).toString("base64") };
    assert.notEqual(badIdentity.daemonPublicKeyB64, offer.daemonPublicKeyB64);
    const encode = (value) =>
      `https://app.paseo.sh/#offer=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
    assert.deepEqual(parseConnectionOfferFromUrl(encode(badIdentity)), badIdentity);
    await expectFailure(
      "failure.wrong-identity",
      client(["ls", "--json"], encode(badIdentity), 60_000),
      /connect|handshake|identity|encrypt|timeout/i,
    );
    const deadRelay = { ...offer, relay: { endpoint: "127.0.0.1:1", useTls: false } };
    await expectFailure(
      "failure.unreachable-relay",
      client(["ls", "--json"], encode(deadRelay), 60_000),
      /ECONNREFUSED|connection.*refused/i,
    );
    await expectFailure(
      "failure.missing-session",
      launcher(["status", randomUUID()]),
      /No session state/,
    );
    const badId = await create("invalid-key");
    await expectFailure(
      "failure.invalid-key",
      launcher(["provision", badId], 60_000, { AI_GATEWAY_API_KEY: "invalid" }),
      /rejected by Vercel AI Gateway/,
    );
    await assert.rejects(sandboxFor(badId, false), isNotFound);
    await destroy(badId);

    const sacrificial = await create("recovery-negative");
    await requireCommand(
      "failure-fixture.provision",
      launcher(["provision", sacrificial], 900_000),
    );
    const missingBinarySandbox = await sandboxFor(sacrificial);
    const providerState = ownState(sacrificial);
    const { resolveProvider } = await import("../dist/providers.js");
    const binaryName = resolveProvider(providerState.agentProvider).binary;
    const binary = (
      await remote(sacrificial, "bash", [
        "-lc",
        `export PATH="$HOME/.npm-global/bin:$PATH"; command -v ${quote(binaryName)}`,
      ])
    ).trim();
    const hidden = `${binary}.live-hidden-${journal.runId}`;
    await remote(sacrificial, "mv", ["--", binary, hidden]);
    try {
      await assertProviderUnavailable(missingBinarySandbox, providerState);
      record("failure.missing-agent-binary");
    } finally {
      await remote(sacrificial, "mv", ["--", hidden, binary]);
    }
    await requireCommand("failure-fixture.stop", launcher(["stop", sacrificial]));
    const saved = ownState(sacrificial);
    const priorUrl = saved.pairingUrl;
    for (const [label, pairingUrl] of [
      ["missing", null],
      ["malformed", "https://app.paseo.sh/#offer=not-json"],
    ]) {
      patchState(sacrificial, { pairingUrl });
      try {
        await expectFailure(
          `failure.${label}-stored-offer`,
          launcher(["resume", sacrificial], 90_000),
          /pairing.*(missing|required|invalid|malformed)|(?:missing|invalid|malformed).*pairing/i,
        );
        assert.equal(
          (await sandboxFor(sacrificial, false)).status,
          "stopped",
          "Invalid saved offer woke the VM",
        );
      } finally {
        patchState(sacrificial, { pairingUrl: priorUrl });
      }
    }
    const corrupt = {
      ...parseConnectionOfferFromUrl(priorUrl),
      daemonPublicKeyB64: badIdentity.daemonPublicKeyB64,
    };
    patchState(sacrificial, { pairingUrl: encode(corrupt) });
    try {
      await expectFailure(
        "failure.stale-stored-identity",
        launcher(["resume", sacrificial], 300_000),
        /daemon identity changed across resume|daemon identity mismatch/i,
      );
      assert.notEqual(
        ownState(sacrificial).phase,
        "ready",
        "Mismatched identity reported successful recovery",
      );
      // A syntactically valid offer requires the restored daemon for comparison.
      record("failure.stale-identity-rejected-after-recovery", {
        sandboxStatus: (await sandboxFor(sacrificial, false)).status,
      });
    } finally {
      patchState(sacrificial, { pairingUrl: priorUrl });
    }

    await requireCommand(
      "failure-fixture.stop-after-rejected-identity",
      launcher(["stop", sacrificial]),
    );
    await requireCommand(
      "failure-fixture.restore-valid-identity",
      launcher(["resume", sacrificial], 300_000),
    );
    const missingHome = `/vercel/missing-paseo-${journal.runId}`;
    const homeExists = () =>
      remoteJson(sacrificial, "console.log(require('node:fs').existsSync(process.argv[1]))", [
        missingHome,
      ]);
    assert.equal(await homeExists(), false, "Missing-home fixture already exists");
    await requireCommand(
      "failure-fixture.stop-before-missing-home",
      launcher(["stop", sacrificial]),
    );
    patchState(sacrificial, { paseoHome: missingHome });
    try {
      const outcome = await expectFailure(
        "failure.missing-recovery-state",
        launcher(["resume", sacrificial], 300_000),
        /daemon failed to start:|daemon identity changed across resume|daemon identity mismatch/i,
      );
      assert.notEqual(
        ownState(sacrificial).phase,
        "ready",
        "Missing recovery home reported successful recovery",
      );
      const diagnostic = `${outcome.stdout}\n${outcome.stderr}`;
      const status = (await sandboxFor(sacrificial, false)).status;
      record("failure.missing-home-diagnosis", {
        homeExistedBefore: false,
        homeExistsAfter: status === "running" ? await homeExists() : null,
        sandboxStatus: status,
        rejection: /daemon failed to start:/.test(diagnostic)
          ? "daemon-startup-failed"
          : "new-daemon-identity-rejected",
      });
    } finally {
      patchState(sacrificial, { paseoHome: saved.paseoHome });
    }
    await destroy(sacrificial);
  }
  async function exportCleanup() {
    await exportChecked("final-export");
    await destroy(sessionId);
  }
  const actions = {
    "provision-auth": provisionAuth,
    "fixture-edit": fixtureEdit,
    reconnect,
    "stop-resume": recovery,
    interruption,
    failures,
    "export-cleanup": exportCleanup,
  };
  try {
    checkpoint();
    for (const name of stage === "all" ? stageOrder : [stage]) {
      abort.signal.throwIfAborted();
      if (name !== "provision-auth")
        assert.ok(sessionId, "This stage requires --session from this run");
      await actions[name]();
      record(`stage.${name}`);
    }
  } catch (error) {
    record("journey.error", {
      ok: false,
      stderr: `${String(error.message)}\n${String(error.stderr ?? "")}`,
      stdout: String(error.stdout ?? ""),
    });
  } finally {
    const failed = results.some((item) => !item.ok) || abort.signal.aborted;
    if (!keep || failed) {
      const errors = await cleanupAll(
        journal.owned,
        (owned) => destroy(owned.id),
        (owned, error) =>
          record("cleanup.error", {
            ok: false,
            sessionId: owned.id,
            stderr: String(error.message),
          }),
      );
      cleanupFailed = errors.length > 0;
    }
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    atomicJson(resultsPath, results);
  }
  const failed = cleanupFailed || results.some((item) => !item.ok) || abort.signal.aborted;
  console.log(`${failed ? "FAILED" : "PASSED"} ${stage}; graphical/mobile coverage not tested`);
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
      return code;
    })
    .catch(() => {
      console.error(
        "Live runner setup failed; check the per-run directories and compiled launcher. No raw diagnostics printed.",
      );
      process.exitCode = 1;
    });
}
