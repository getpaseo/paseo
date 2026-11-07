import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const devHomeScript = join(import.meta.dirname, "dev-home.sh");

// A dev home is a second Paseo home. With no agents.skills.selection the daemon defaults to
// mode "all" and syncs its bundled skills into the real ~/.agents/skills, ~/.claude/skills and
// ~/.codex/skills, so every config this script writes must pin an empty custom selection.
const EMPTY_SELECTION = { mode: "custom", skills: [] };

function configureDevDaemonConfig({ home, listen }) {
  const result = spawnSync(
    "bash",
    ["-c", `source "${devHomeScript}"; configure_dev_daemon_config`],
    {
      env: { ...process.env, PASEO_HOME: home, PASEO_LISTEN: listen },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
}

function withTempHome(run) {
  const root = mkdtempSync(join(tmpdir(), "paseo-dev-home-"));
  try {
    run(join(root, "home"), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a new dev home config pins an empty skill selection", () => {
  withTempHome((home) => {
    const config = configureDevDaemonConfig({ home, listen: "127.0.0.1:6768" });

    assert.deepEqual(config.agents.skills.selection, EMPTY_SELECTION);
    assert.equal(config.daemon.listen, "127.0.0.1:6768");
  });
});

test("a config copied from a real home that syncs all skills is overridden", () => {
  withTempHome((home) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        agents: { skills: { selection: { mode: "all" } }, providers: { omp: { enabled: true } } },
      }),
    );

    const config = configureDevDaemonConfig({ home, listen: "127.0.0.1:6768" });

    assert.deepEqual(config.agents.skills.selection, EMPTY_SELECTION);
    assert.deepEqual(config.agents.providers, { omp: { enabled: true } });
  });
});

test("the selection is pinned even when no listen address is given", () => {
  withTempHome((home) => {
    const config = configureDevDaemonConfig({ home, listen: "" });

    assert.deepEqual(config.agents.skills.selection, EMPTY_SELECTION);
    assert.equal(config.daemon, undefined);
  });
});

test("rewriting the config leaves no temporary file behind", () => {
  withTempHome((home) => {
    configureDevDaemonConfig({ home, listen: "127.0.0.1:6768" });
    configureDevDaemonConfig({ home, listen: "127.0.0.1:6768" });

    assert.deepEqual(readdirSync(home), ["config.json"]);
  });
});

test("the config stays private: an existing 0600 config is not loosened and a new one is 0600", () => {
  withTempHome((home) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1 }));
    chmodSync(join(home, "config.json"), 0o600);

    configureDevDaemonConfig({ home, listen: "127.0.0.1:6768" });

    assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600);
  });

  withTempHome((home) => {
    configureDevDaemonConfig({ home, listen: "127.0.0.1:6768" });

    assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600);
  });
});
