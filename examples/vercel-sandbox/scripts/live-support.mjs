import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve, relative, isAbsolute, basename, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const stageOrder = [
  "provision-auth",
  "fixture-edit",
  "reconnect",
  "stop-resume",
  "interruption",
  "failures",
  "export-cleanup",
];
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const fileHash = (path) => (existsSync(path) ? hash(readFileSync(path)) : "MISSING");

export function sanitize(value, secrets = []) {
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /pairing|password|secret|authorization|api.?key|token|daemonPublicKey/i.test(key)
          ? "[REDACTED]"
          : sanitize(item, secrets),
      ]),
    );
  if (typeof value !== "string") return value;
  // Subprocess output can itself be a JSON document with identity/key fields.
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") return JSON.stringify(sanitize(parsed, secrets));
  } catch {
    /* Plain diagnostics are scrubbed below. */
  }
  let text = value;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const form of new Set([secret, encodeURIComponent(secret)]))
      text = text.split(form).join("[REDACTED]");
  }
  return text
    .replace(/https?:\/\/[^\s"'<>]*#offer=[^\s"'<>]+/gi, "[REDACTED]")
    .replace(/https?%3A%2F%2F[^\s"'<>]*%23offer%3D[^\s"'<>]+/gi, "[REDACTED]")
    .replace(/#offer=[^\s"'<>]+/gi, "#offer=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(
      /((?:[A-Z_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)|authorization|pairingUrl|daemonPublicKeyB64)["']?\s*[:=]\s*["']?)[^\s,"']+/gi,
      "$1[REDACTED]",
    );
}

export function atomicJson(path, value, expected = fileHash(path)) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.edit-lock`;
  const fd = openSync(lock, "wx", 0o600);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    assert.equal(fileHash(path), expected, "STALE_PRECONDITION");
    const bytes = JSON.stringify(value, null, 2) + "\n";
    const out = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(out, bytes);
      fsyncSync(out);
    } finally {
      closeSync(out);
    }
    renameSync(tmp, path);
    const receipts = join(dirname(path), ".live-write-receipts");
    mkdirSync(receipts, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(receipts, `${randomUUID()}.json`),
      JSON.stringify({
        target: path,
        actor: "paseo-live-runner",
        reason: "verification checkpoint",
        pre: expected,
        post: hash(bytes),
        at: new Date().toISOString(),
        result: "WRITE_COMMITTED",
      }),
      { mode: 0o600, flag: "wx" },
    );
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
    closeSync(fd);
    unlinkSync(lock);
  }
}

export async function waitUntil(
  read,
  ready,
  { timeoutMs = 120_000, intervalMs = 1000, signal } = {},
) {
  const deadline = Date.now() + timeoutMs;
  do {
    signal?.throwIfAborted();
    const value = await read();
    if (ready(value)) return value;
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())), undefined, { signal });
  } while (Date.now() < deadline);
  throw new Error("Observation deadline expired without the required evidence");
}

export function conversationEvidence(agent, page) {
  assert.ok(
    agent?.id && agent.persistence?.sessionId && agent.persistence?.nativeHandle,
    "missing agent persistence",
  );
  assert.equal(agent.provider, "codex");
  assert.equal(agent.persistence.provider, "codex");
  assert.ok(agent.workspaceId && agent.cwd, "missing workspace identity");
  assert.ok(!page.error && !page.gap && !page.hasOlder && !page.hasNewer, "incomplete timeline");
  const messages = page.entries
    .map((entry) => entry.item)
    .filter((item) => ["user_message", "assistant_message"].includes(item.type));
  let assistantSeenInTurn = false;
  const messageEvidence = messages.map((item) => {
    if (item.type === "user_message") assistantSeenInTurn = false;
    const boundary =
      item.type === "assistant_message" &&
      assistantSeenInTurn &&
      item.messageId &&
      item.text.startsWith("\n\n---\n\n");
    if (item.type === "assistant_message") assistantSeenInTurn = true;
    const text = (boundary ? item.text.slice(7) : item.text).trim();
    return {
      type: item.type,
      messageId: item.messageId ?? null,
      presentationBoundary: Boolean(boundary),
      rawHash: hash(item.text),
      contentHash: hash(JSON.stringify({ type: item.type, text })),
    };
  });
  return {
    id: agent.id,
    provider: agent.provider,
    workspaceId: agent.workspaceId,
    cwd: agent.cwd,
    sessionId: agent.persistence.sessionId,
    nativeHandle: agent.persistence.nativeHandle,
    status: agent.status,
    userMessages: messages.filter((item) => item.type === "user_message").length,
    assistantMessages: messages.filter((item) => item.type === "assistant_message").length,
    history: messageEvidence.map((item) => item.contentHash),
    messageEvidence,
    toolCalls: page.entries.filter((entry) => entry.item.type === "tool_call").length,
  };
}

export function assertContinuity(before, after, followup = false) {
  for (const key of ["id", "provider", "workspaceId", "cwd", "sessionId", "nativeHandle"])
    assert.equal(after[key], before[key], `${key} changed`);
  assert.ok(before.history.length > 0, "baseline history is empty");
  let cursor = 0;
  for (let index = 0; index < after.history.length && cursor < before.history.length; index++) {
    const original = before.messageEvidence?.[cursor];
    const recovered = after.messageEvidence?.[index];
    const sameIdentity =
      original?.type !== "assistant_message" || original.messageId === recovered?.messageId;
    if (sameIdentity && after.history[index] === before.history[cursor]) cursor++;
  }
  assert.equal(cursor, before.history.length, "conversation history was lost or reordered");
  if (followup)
    assert.ok(
      after.userMessages > before.userMessages &&
        after.assistantMessages > before.assistantMessages,
      "no completed new turn",
    );
}

export function verifyExport(directory, manifest) {
  const files = {};
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(directory, path);
      assert.ok(!entry.isSymbolicLink(), "symlink in export");
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files[`./${rel.split("\\").join("/")}`] = hash(readFileSync(path));
    }
  }
  walk(directory);
  assert.ok(Object.keys(manifest).length > 0, "empty export manifest");
  for (const [path, digest] of Object.entries(manifest)) {
    const rel = relative(resolve(directory), resolve(directory, path));
    assert.ok(
      !isAbsolute(path) && rel && !rel.startsWith("..") && !isAbsolute(rel),
      "unsafe export path",
    );
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(files[`./${rel}`], digest, `export hash mismatch: ${path}`);
  }
  assert.deepEqual(
    Object.keys(files).sort(),
    Object.keys(manifest)
      .map((p) => `./${relative(directory, resolve(directory, p))}`)
      .sort(),
    "export has missing or additional files",
  );
  return {
    files: Object.keys(files).length,
    manifestHash: hash(JSON.stringify(Object.entries(files).sort())),
  };
}

export function assertInterrupted(before, after) {
  assert.notEqual(after.bootId, before.bootId, "VM boot did not change");
  assert.equal(after.scriptHash, before.scriptHash, "controlled program changed");
  assert.deepEqual(after.activePids, [], "controlled process is still running or replayed");
  assert.deepEqual(after.marker, before.marker, "heartbeat advanced after stop");
  assert.deepEqual(after.starts, before.starts, "controlled work started again");
  assert.equal(after.starts.length, 1, "expected exactly one controlled process start");
  assert.equal(after.done, false, "controlled work finished instead of being interrupted");
}

// Receipt failures must not stop attempts to clean the remaining owned resources.
export async function cleanupAll(owned, destroy, report) {
  const errors = [];
  for (const item of owned) {
    try {
      await destroy(item);
    } catch (error) {
      errors.push({ id: item.id, error });
      try {
        await report(item, error);
      } catch {
        /* Preserve cleanup progress if evidence storage fails. */
      }
    }
  }
  return errors;
}

export async function waitForUiGate(path, sessionId, record, options = {}) {
  if (!path) return;
  const timeoutMs = Math.min(options.timeoutMs ?? 600_000, 600_000);
  assert.ok(isAbsolute(path) && timeoutMs > 0, "Invalid UI gate");
  record("ui-ready", { sessionId, gateFile: path, maximumWaitMs: timeoutMs });
  await waitUntil(async () => existsSync(path), Boolean, { ...options, timeoutMs });
  record("ui-gate-released", {
    sessionId,
    coverage: "Parent must record graphical observations separately",
  });
}

export function assertDisjointDirectories(first, second) {
  function canonical(path) {
    let ancestor = resolve(path);
    const suffix = [];
    while (!existsSync(ancestor)) {
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
    return resolve(realpathSync(ancestor), ...suffix);
  }
  const paths = [canonical(first), canonical(second)];
  for (const [parent, child] of [paths, paths.toReversed()]) {
    const rel = relative(parent, child);
    assert.ok(
      rel && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)),
      "State and receipts directories must be disjoint",
    );
  }
}
