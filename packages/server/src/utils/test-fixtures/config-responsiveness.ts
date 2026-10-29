import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { measureMainThreadWork } from "../../test-utils/main-thread-work.js";
import { readPaseoConfigForEdit } from "../paseo-config-file.js";

// Keep Vitest transforms, reporting, and unrelated callbacks outside the measured
// thread. Read the real file once, without warming the config snapshot or schema.
const directory = process.argv[2];
assert.ok(directory, "Config directory is required");
await nextTurn();
const measured = await measureMainThreadWork("project config main-thread work", () =>
  readPaseoConfigForEdit(directory),
);
process.stdout.write(JSON.stringify(measured));
