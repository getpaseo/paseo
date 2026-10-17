// Opt-in live model QA: authenticate normally before running; credentials stay in memory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "../support/fixtures";
import { verifyRealHermesDelegation } from "../support/helpers/hermes-real-model";
const python = process.env.PASEO_HERMES_REAL_PYTHON;
const script = process.env.PASEO_HERMES_REAL_SCRIPT;
const authHome = process.env.PASEO_HERMES_REAL_AUTH_HOME;
const failure = process.env.PASEO_HERMES_REAL_FAIL_CHILD === "1";
const enabled = Boolean(python && script && authHome);
const home = mkdtempSync(path.join(tmpdir(), "hermes-live-model-qa-"));
test.use({
  e2eDaemonEnvironment: {
    HERMES_HOME: home,
    QA_AUTH_HOME: authHome ?? "",
    QA_FAIL_CHILD: failure ? "1" : "0",
  },
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        hermes: {
          extends: "acp",
          label: "Hermes real-model QA",
          enabled: true,
          command: enabled ? [python!, script!] : ["false"],
        },
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
        omp: { enabled: false },
      },
    },
  },
});
test.afterAll(() => rmSync(home, { recursive: true, force: true }));
test(
  failure
    ? "REAL MODEL unavailable child model fails"
    : "REAL MODEL child continues after parent reply and running reconnect",
  async ({ page }, info) => {
    test.skip(!enabled, "Set all PASEO_HERMES_REAL_* paths to opt in to authenticated live QA");
    test.setTimeout(300000);
    await verifyRealHermesDelegation(page, info, failure);
  },
);
