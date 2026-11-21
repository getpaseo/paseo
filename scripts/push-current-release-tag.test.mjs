import assert from "node:assert/strict";
import test from "node:test";

import { assertReleaseBranch } from "./push-current-release-tag.mjs";

test("accepts release/* branches for release pushes", () => {
  assert.doesNotThrow(() => assertReleaseBranch("release/v0.17.0-beta.2"));
  assert.doesNotThrow(() => assertReleaseBranch("release/v0.17.0"));
  assert.doesNotThrow(() => assertReleaseBranch("release/0.17.1-hotfix"));
});

test("refuses main and non-release branches for release pushes", () => {
  assert.throws(() => assertReleaseBranch("main"), /release\/\*/);
  assert.throws(() => assertReleaseBranch("feat/something"), /release\/\*/);
  assert.throws(() => assertReleaseBranch("release/"), /release\/\*/);
  assert.throws(() => assertReleaseBranch(""), /release\/\*/);
});
