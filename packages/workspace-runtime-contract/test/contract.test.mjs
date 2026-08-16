import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

test("the public contract contains no host or provider authority fields", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /host-directory|hostVisiblePath|provider-probe|provider:/u);
});
import { promisify } from "node:util";

import {
  CommandRuntimeControlSchema,
  CommandRuntimeDescribeResponseSchema,
  CommandRuntimeLifecycleRequestSchema,
  CommandRuntimeLifecycleResponseSchema,
  CommandRuntimeProcessEventSchema,
  CommandRuntimeProjectSourceSchema,
  CommandRuntimePlacementIntentSchema,
  CommandRuntimeCreateInputSchema,
  CommandRuntimeInspectionSchema,
  CommandRuntimePlacementSchema,
  CommandRuntimeProcessPurposeSchema,
  CommandRuntimeSpawnEnvelopeSchema,
  CommandRuntimeStdioSchema,
  CommandRuntimeStateSchema,
  createCommandRuntimeMessageDecoder,
  createCommandRuntimeProcessEventDecoder,
  encodeCommandRuntimeMessage,
} from "../dist/index.js";

const run = promisify(execFile);
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmPrefixArgs =
  process.platform === "win32" ? [requireEnvironmentVariable("npm_execpath")] : [];
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examples = JSON.parse(await readFile(path.join(packageRoot, "examples/v1.json"), "utf8"));

function requireEnvironmentVariable(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to invoke npm on Windows`);
  return value;
}

function runNpm(args, options) {
  return run(npmCommand, [...npmPrefixArgs, ...args], options);
}

test("documented lifecycle, fd3, control, and fd4 examples are exact newline-terminated bytes", () => {
  for (const [name, schema] of [
    ["describeResponse", CommandRuntimeDescribeResponseSchema],
    ["lifecycleRequest", CommandRuntimeLifecycleRequestSchema],
    ["lifecycleResponse", CommandRuntimeLifecycleResponseSchema],
    ["pipeSpawnControl", CommandRuntimeControlSchema],
    ["ptySpawnControl", CommandRuntimeControlSchema],
    ["resizeControl", CommandRuntimeControlSchema],
    ["signalControl", CommandRuntimeControlSchema],
    ["startedEvent", CommandRuntimeProcessEventSchema],
    ["eofEvent", CommandRuntimeProcessEventSchema],
    ["resizedEvent", CommandRuntimeProcessEventSchema],
    ["exitEvent", CommandRuntimeProcessEventSchema],
    ["errorEvent", CommandRuntimeProcessEventSchema],
  ]) {
    const bytes = encodeCommandRuntimeMessage(schema, examples[name]);
    assert.equal(bytes, examples.bytes[name]);
    assert.equal(bytes.endsWith("\n"), true);
    assert.equal(bytes.endsWith("\n\n"), false);
  }
});

test("lifecycle uses one exact stdin request and one exact stdout response", async () => {
  assert.equal(examples.lifecycleRequest.input.purpose, "discovery");
  assert.deepEqual(examples.lifecycleResponse.state, {
    workspaceId: "workspace-01",
    lifecycle: "ready",
  });
  assert.equal(examples.lifecycleResponse.materializedFreshContent, true);
  assert.doesNotMatch(examples.bytes.lifecycleResponse, /root|revision|executionDomainId/);
  const child = spawn(
    process.execPath,
    [path.join(packageRoot, "test/pipe-fixture.mjs"), "lifecycle"],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end(examples.bytes.lifecycleRequest);
  const [stdout, stderr, exit] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    exited(child),
  ]);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(stdout.toString(), examples.bytes.lifecycleResponse);
  assert.equal(stderr.length, 0);
});

test("pipes use one fd3 spawn then started/eof/exit on fd4 with raw fd0/1/2", async () => {
  const child = spawn(process.execPath, [path.join(packageRoot, "test/pipe-fixture.mjs")], {
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  child.stdin.end(Buffer.from("raw\u0000stdin\n"));
  child.stdio[3].end(examples.bytes.pipeSpawnControl);
  const [stdout, stderr, events, exit] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    collect(child.stdio[4]),
    exited(child),
  ]);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.deepEqual(stdout, Buffer.from([0x00, 0x6f, 0x75, 0x74, 0xff]));
  assert.deepEqual(stderr, Buffer.from([0x65, 0x72, 0x72, 0x00]));
  assert.equal(
    events.toString(),
    examples.bytes.startedEvent + examples.bytes.eofEvent + examples.bytes.exitEvent,
  );
  assert.deepEqual(decodeEvents(events), [
    examples.startedEvent,
    examples.eofEvent,
    examples.exitEvent,
  ]);
});

test("PTY keeps fd3 open for resize and signal through EOF and emits a valid fd4 sequence", async () => {
  const child = spawn(process.execPath, [path.join(packageRoot, "test/pty-fixture.mjs")], {
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  child.stdin.end(Buffer.from([0x74, 0x65, 0x72, 0x6d, 0x00, 0xff]));
  child.stdio[3].write(examples.bytes.ptySpawnControl);
  child.stdio[3].write(examples.bytes.resizeControl);
  child.stdio[3].end(examples.bytes.signalControl);
  const [stdout, stderr, events, exit] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    collect(child.stdio[4]),
    exited(child),
  ]);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.deepEqual(stdout, Buffer.from([0x74, 0x65, 0x72, 0x6d, 0x00, 0xff]));
  assert.deepEqual(stderr, Buffer.from([0x70, 0x74, 0x79, 0x00]));
  assert.equal(
    events.toString(),
    examples.bytes.startedEvent +
      examples.bytes.resizedEvent +
      examples.bytes.eofEvent +
      '{"type":"exit","protocolVersion":1,"code":null,"signal":"SIGTERM"}\n',
  );
  assert.deepEqual(
    decodeEvents(events).map((event) => event.type),
    ["started", "resized", "eof", "exit"],
  );
});

test("actual fd4 rejects malformed and wrong-version frames and detects early wrapper exit", async () => {
  for (const [mode, pattern] of [
    ["malformed", SyntaxError],
    ["wrong-version", /expected 1/],
  ]) {
    const child = spawn(process.execPath, [path.join(packageRoot, "test/pipe-fixture.mjs"), mode], {
      stdio: ["ignore", "ignore", "ignore", "ignore", "pipe"],
    });
    const [events, exit] = await Promise.all([collect(child.stdio[4]), exited(child)]);
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.throws(() => decodeEvents(events), pattern);
  }

  const early = spawn(
    process.execPath,
    [path.join(packageRoot, "test/pipe-fixture.mjs"), "early-exit"],
    { stdio: ["ignore", "ignore", "ignore", "ignore", "pipe"] },
  );
  const [events, exit] = await Promise.all([collect(early.stdio[4]), exited(early)]);
  assert.equal(events.length, 0);
  assert.deepEqual(exit, { code: 47, signal: null });
});

test("framing accepts partial bytes and rejects malformed, early EOF, and wrong versions", () => {
  const partial = createCommandRuntimeMessageDecoder(CommandRuntimeProcessEventSchema);
  assert.deepEqual(partial.push(examples.bytes.exitEvent.slice(0, 11)), []);
  assert.deepEqual(partial.push(examples.bytes.exitEvent.slice(11)), [examples.exitEvent]);
  partial.finish();

  const malformed = createCommandRuntimeMessageDecoder(CommandRuntimeProcessEventSchema);
  assert.throws(() => malformed.push("{nope}\n"), SyntaxError);

  const early = createCommandRuntimeMessageDecoder(CommandRuntimeProcessEventSchema);
  early.push(examples.bytes.exitEvent.slice(0, -1));
  assert.throws(() => early.finish(), /ended before newline/);

  const wrongVersion = createCommandRuntimeMessageDecoder(CommandRuntimeProcessEventSchema);
  assert.throws(
    () => wrongVersion.push('{"type":"exit","protocolVersion":2,"code":0,"signal":null}\n'),
    /expected 1/,
  );
});

test("process event conversations enforce the complete mode-specific lifecycle", () => {
  for (const [mode, events] of [
    ["pipes", [examples.startedEvent, examples.eofEvent, examples.exitEvent]],
    ["pty", [examples.startedEvent, examples.resizedEvent, examples.eofEvent, examples.exitEvent]],
  ]) {
    const decoder = createCommandRuntimeProcessEventDecoder(mode);
    assert.deepEqual(
      decoder.push(
        events
          .map((event) => encodeCommandRuntimeMessage(CommandRuntimeProcessEventSchema, event))
          .join(""),
      ),
      events,
    );
    decoder.finish();
  }

  for (const [name, mode, events, pattern] of [
    ["exit before eof", "pipes", [examples.startedEvent, examples.exitEvent], /exit before eof/],
    ["eof before started", "pipes", [examples.eofEvent], /eof before started/],
    ["exit before started", "pipes", [examples.exitEvent], /exit before started/],
    [
      "duplicate started",
      "pipes",
      [examples.startedEvent, examples.startedEvent],
      /duplicate started/,
    ],
    [
      "duplicate eof",
      "pipes",
      [examples.startedEvent, examples.eofEvent, examples.eofEvent],
      /duplicate eof/,
    ],
    [
      "duplicate exit",
      "pipes",
      [examples.startedEvent, examples.eofEvent, examples.exitEvent, examples.exitEvent],
      /duplicate exit/,
    ],
    [
      "post-exit lifecycle",
      "pipes",
      [examples.startedEvent, examples.eofEvent, examples.exitEvent, examples.eofEvent],
      /event after exit/,
    ],
    [
      "wrong-mode resize",
      "pipes",
      [examples.startedEvent, examples.resizedEvent],
      /pipes.*resized/,
    ],
    ["PTY resize before started", "pty", [examples.resizedEvent], /resized before started/],
    [
      "PTY resize after eof",
      "pty",
      [examples.startedEvent, examples.eofEvent, examples.resizedEvent],
      /resized after eof/,
    ],
    [
      "PTY post-exit acknowledgement",
      "pty",
      [examples.startedEvent, examples.eofEvent, examples.exitEvent, examples.resizedEvent],
      /event after exit/,
    ],
  ]) {
    const decoder = createCommandRuntimeProcessEventDecoder(mode);
    assert.throws(
      () =>
        decoder.push(
          events
            .map((event) => encodeCommandRuntimeMessage(CommandRuntimeProcessEventSchema, event))
            .join(""),
        ),
      pattern,
      name,
    );
  }
});

test("every public v1 object rejects unknown authority at every nesting level", () => {
  const createInput = examples.lifecycleRequest.input;
  const gitSource = {
    kind: "git",
    url: "https://example.invalid/repository.git",
    revision: "main",
    subdirectory: "project",
  };
  const resolvedPlacement = {
    kind: "resolved-worktree",
    worktreeSlug: "change-7",
    source: {
      kind: "checkout-change-request",
      headRef: "feature",
      baseRefName: "main",
      checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/heads/feature" }],
    },
  };
  const readyInspection = {
    status: "ready",
    state: examples.lifecycleResponse.state,
    placement: examples.lifecycleResponse.placement,
  };
  const pausedInspection = {
    status: "paused",
    state: { ...examples.lifecycleResponse.state, lifecycle: "paused" },
    placement: examples.lifecycleResponse.placement,
  };
  const strictCases = [
    ["describe", CommandRuntimeDescribeResponseSchema, examples.describeResponse, []],
    ["create request", CommandRuntimeLifecycleRequestSchema, examples.lifecycleRequest, []],
    [
      "create request input",
      CommandRuntimeLifecycleRequestSchema,
      examples.lifecycleRequest,
      ["input"],
    ],
    [
      "inspect request",
      CommandRuntimeLifecycleRequestSchema,
      { protocolVersion: 1, options: {} },
      [],
    ],
    [
      "pause request",
      CommandRuntimeLifecycleRequestSchema,
      { protocolVersion: 1, options: {} },
      [],
    ],
    [
      "resume request",
      CommandRuntimeLifecycleRequestSchema,
      { protocolVersion: 1, options: {} },
      [],
    ],
    [
      "destroy request",
      CommandRuntimeLifecycleRequestSchema,
      { protocolVersion: 1, options: {} },
      [],
    ],
    ["create input", CommandRuntimeCreateInputSchema, createInput, []],
    ["create project", CommandRuntimeCreateInputSchema, createInput, ["project"]],
    ["create source", CommandRuntimeCreateInputSchema, createInput, ["project", "source"]],
    ["create placement", CommandRuntimeCreateInputSchema, createInput, ["placement"]],
    ["host source", CommandRuntimeProjectSourceSchema, createInput.project.source, []],
    ["git source", CommandRuntimeProjectSourceSchema, gitSource, []],
    ["existing placement", CommandRuntimePlacementIntentSchema, createInput.placement, []],
    [
      "branch placement",
      CommandRuntimePlacementIntentSchema,
      { kind: "branch", branchName: "feature", baseRef: "main" },
      [],
    ],
    [
      "checkout placement",
      CommandRuntimePlacementIntentSchema,
      { kind: "checkout", ref: "feature" },
      [],
    ],
    ["resolved placement", CommandRuntimePlacementIntentSchema, resolvedPlacement, []],
    ["resolved source", CommandRuntimePlacementIntentSchema, resolvedPlacement, ["source"]],
    [
      "resolved checkout ref",
      CommandRuntimePlacementIntentSchema,
      resolvedPlacement,
      ["source", "checkoutRefs", 0],
    ],
    ["state", CommandRuntimeStateSchema, examples.lifecycleResponse.state, []],
    ["placement", CommandRuntimePlacementSchema, examples.lifecycleResponse.placement, []],
    [
      "create state response",
      CommandRuntimeLifecycleResponseSchema,
      examples.lifecycleResponse,
      [],
    ],
    [
      "resume state response",
      CommandRuntimeLifecycleResponseSchema,
      examples.lifecycleResponse,
      [],
    ],
    [
      "state response state",
      CommandRuntimeLifecycleResponseSchema,
      examples.lifecycleResponse,
      ["state"],
    ],
    [
      "state response placement",
      CommandRuntimeLifecycleResponseSchema,
      examples.lifecycleResponse,
      ["placement"],
    ],
    ["ready inspection", CommandRuntimeInspectionSchema, readyInspection, []],
    ["ready inspection state", CommandRuntimeInspectionSchema, readyInspection, ["state"]],
    ["ready inspection placement", CommandRuntimeInspectionSchema, readyInspection, ["placement"]],
    ["paused inspection", CommandRuntimeInspectionSchema, pausedInspection, []],
    ["paused inspection state", CommandRuntimeInspectionSchema, pausedInspection, ["state"]],
    [
      "paused inspection placement",
      CommandRuntimeInspectionSchema,
      pausedInspection,
      ["placement"],
    ],
    ["missing inspection", CommandRuntimeInspectionSchema, { status: "missing" }, []],
    [
      "error inspection",
      CommandRuntimeInspectionSchema,
      { status: "error", message: "failure" },
      [],
    ],
    [
      "inspection response",
      CommandRuntimeLifecycleResponseSchema,
      { protocolVersion: 1, type: "inspection", inspection: { status: "missing" } },
      [],
    ],
    [
      "ready inspection response state",
      CommandRuntimeLifecycleResponseSchema,
      { protocolVersion: 1, type: "inspection", inspection: readyInspection },
      ["inspection", "state"],
    ],
    [
      "ready inspection response placement",
      CommandRuntimeLifecycleResponseSchema,
      { protocolVersion: 1, type: "inspection", inspection: readyInspection },
      ["inspection", "placement"],
    ],
    [
      "nested inspection",
      CommandRuntimeLifecycleResponseSchema,
      { protocolVersion: 1, type: "inspection", inspection: { status: "missing" } },
      ["inspection"],
    ],
    [
      "pause ok response",
      CommandRuntimeLifecycleResponseSchema,
      { protocolVersion: 1, type: "ok" },
      [],
    ],
    [
      "destroy ok response",
      CommandRuntimeLifecycleResponseSchema,
      { protocolVersion: 1, type: "ok" },
      [],
    ],
    ["agent purpose", CommandRuntimeProcessPurposeSchema, { kind: "agent" }, []],
    ["terminal purpose", CommandRuntimeProcessPurposeSchema, { kind: "terminal" }, []],
    ["Git purpose", CommandRuntimeProcessPurposeSchema, { kind: "git" }, []],
    ["discovery purpose", CommandRuntimeProcessPurposeSchema, { kind: "discovery" }, []],
    ["helper purpose", CommandRuntimeProcessPurposeSchema, { kind: "workspace-helper" }, []],
    ["script purpose", CommandRuntimeProcessPurposeSchema, examples.pipeSpawnControl.purpose, []],
    ["setup purpose", CommandRuntimeProcessPurposeSchema, { kind: "setup" }, []],
    ["archive purpose", CommandRuntimeProcessPurposeSchema, { kind: "archive" }, []],
    ["pipes stdio", CommandRuntimeStdioSchema, { kind: "pipes" }, []],
    ["PTY stdio", CommandRuntimeStdioSchema, examples.ptySpawnControl.stdio, []],
    ["spawn", CommandRuntimeSpawnEnvelopeSchema, examples.pipeSpawnControl, []],
    ["spawn purpose", CommandRuntimeSpawnEnvelopeSchema, examples.pipeSpawnControl, ["purpose"]],
    ["spawn stdio", CommandRuntimeSpawnEnvelopeSchema, examples.pipeSpawnControl, ["stdio"]],
    ["resize control", CommandRuntimeControlSchema, examples.resizeControl, []],
    ["signal control", CommandRuntimeControlSchema, examples.signalControl, []],
    ["started event", CommandRuntimeProcessEventSchema, examples.startedEvent, []],
    ["eof event", CommandRuntimeProcessEventSchema, examples.eofEvent, []],
    ["resized event", CommandRuntimeProcessEventSchema, examples.resizedEvent, []],
    ["exit event", CommandRuntimeProcessEventSchema, examples.exitEvent, []],
    ["error event", CommandRuntimeProcessEventSchema, examples.errorEvent, []],
  ];
  for (const [name, schema, value, nestingPath] of strictCases) {
    for (const field of ["root", "unknownV1Field"]) {
      assert.throws(
        () => schema.parse(inject(value, nestingPath, field, "/private")),
        /unrecognized key/i,
        `${name} accepted ${field}`,
      );
    }
  }
});

test("v1 extension maps stay explicit and future versions fail by protocol version", () => {
  assert.deepEqual(
    CommandRuntimeLifecycleRequestSchema.parse({
      protocolVersion: 1,
      runtimeInstanceId: examples.lifecycleRequest.runtimeInstanceId,
      options: { root: "runtime-private-option", vendorExtension: { nested: true } },
    }).options,
    { root: "runtime-private-option", vendorExtension: { nested: true } },
  );
  assert.deepEqual(
    CommandRuntimeStateSchema.parse({
      ...examples.lifecycleResponse.state,
      lifecycleEnvironment: { root: "environment-value", VENDOR_VALUE: "accepted" },
    }).lifecycleEnvironment,
    { root: "environment-value", VENDOR_VALUE: "accepted" },
  );
  assert.deepEqual(
    CommandRuntimeSpawnEnvelopeSchema.parse({
      ...examples.pipeSpawnControl,
      env: { root: "workload-environment-value" },
      options: { vendorExtension: true },
    }),
    {
      ...examples.pipeSpawnControl,
      env: { root: "workload-environment-value" },
      options: { vendorExtension: true },
    },
  );
  for (const [schema, value] of [
    [CommandRuntimeDescribeResponseSchema, examples.describeResponse],
    [CommandRuntimeLifecycleRequestSchema, examples.lifecycleRequest],
    [CommandRuntimeLifecycleResponseSchema, examples.lifecycleResponse],
    [CommandRuntimeControlSchema, examples.pipeSpawnControl],
    [CommandRuntimeProcessEventSchema, examples.startedEvent],
  ]) {
    assert.throws(() => schema.parse({ ...value, protocolVersion: 2 }), /expected 1/);
  }
});

test("public state schemas reject physical authority under computed and aliased spellings", () => {
  const root = ["ro", "ot"].join("");
  const state = { workspaceId: "workspace-01", lifecycle: "ready", [root]: "/private" };
  const schemaAlias = CommandRuntimeStateSchema;
  assert.throws(() => schemaAlias.parse(state), /unrecognized key/i);
  assert.throws(
    () =>
      CommandRuntimeLifecycleResponseSchema.parse({
        ...examples.lifecycleResponse,
        state: { ...examples.lifecycleResponse.state, [root]: "/private" },
      }),
    /unrecognized key/i,
  );
});

test("every export condition resolves from a packed standalone install", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-runtime-contract-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = JSON.parse(
    (
      await runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", root], {
        cwd: packageRoot,
      })
    ).stdout,
  );
  const archive = path.join(root, pack[0].filename);
  const installRoot = path.join(root, "standalone");
  await mkdir(installRoot);
  await runNpm(["install", "--ignore-scripts", "--no-package-lock", archive], {
    cwd: installRoot,
  });
  const installed = path.join(installRoot, "node_modules/@getpaseo/workspace-runtime-contract");
  const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  for (const target of Object.values(manifest.exports["."])) {
    await stat(path.join(installed, target));
  }
  const imported = await import(pathToFileURL(path.join(installed, manifest.exports["."].default)));
  assert.equal(imported.COMMAND_RUNTIME_PROTOCOL_VERSION, 1);
});

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function exited(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function decodeEvents(bytes) {
  const decoder = createCommandRuntimeMessageDecoder(CommandRuntimeProcessEventSchema);
  const split = Math.min(13, bytes.length);
  const events = [
    ...decoder.push(bytes.subarray(0, split)),
    ...decoder.push(bytes.subarray(split)),
  ];
  decoder.finish();
  return events;
}

function inject(value, nestingPath, field, injected) {
  const copy = structuredClone(value);
  let target = copy;
  for (const segment of nestingPath) target = target[segment];
  target[field] = injected;
  return copy;
}
