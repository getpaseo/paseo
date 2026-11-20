import { createHook, executionAsyncResource } from "node:async_hooks";
import { stat } from "node:fs/promises";
import { MessagePort } from "node:worker_threads";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { measureMainThreadWork } from "../../test-utils/main-thread-work.js";
import { readPaseoConfigForEdit } from "../paseo-config-file.js";

// The parent bundles this fixture before launching plain Node, keeping test
// runner callbacks and runtime loader messages outside the measured thread.
// Read the real file once, without warming the config snapshot or schema.
const directory = process.argv[2];
assert.ok(directory, "Config directory is required");
// The daemon has already used asynchronous filesystem APIs before reading a
// project config. Start libuv's filesystem worker pool outside the measurement:
// its first submission synchronously creates workers in a fresh Node process.
// Stat the probe itself so the config, snapshot and schemas remain cold.
await stat(process.argv[1]);
await nextTurn();
let workerMessages = 0;
const activity = createHook({
  before() {
    if (executionAsyncResource() instanceof MessagePort) workerMessages++;
  },
}).enable();
const measured = await measureMainThreadWork("project config main-thread work", () =>
  readPaseoConfigForEdit(directory),
);
activity.disable();
process.stdout.write(JSON.stringify({ ...measured, workerMessages }));
