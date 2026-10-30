import { createHook, executionAsyncResource } from "node:async_hooks";
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
