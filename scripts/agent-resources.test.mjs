import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertAggregateLimits,
  parseRun,
  scopeArguments,
  assertStoppable,
  parseProperties,
  superviseScope,
  JOB_SHELL,
  ownerIsAlive,
  processStartTicks,
} from "./agent-resources.mjs";

const unit = "paseo-agent-test-123.scope";
const group = `/user.slice/user-1000.slice/user@1000.service/agent.slice/agent-workloads.slice/${unit}`;

test("workload arguments preserve literal argv and keep credentials out of scope descriptions", () => {
  const command = ["node", "--auth", "literal-$TOKEN-$(echo bad)"];
  assert.deepEqual(parseRun(["--timeout", "60", "--", ...command]), {
    command,
    timeoutSeconds: 60,
  });
  assert.deepEqual(parseRun(["--", "node"]), { command: ["node"], timeoutSeconds: null });
  for (const args of [
    [],
    ["--"],
    ["--timeout", "0", "--", "node"],
    ["--timeout", "NaN", "--", "node"],
  ]) {
    assert.throws(() => parseRun(args));
  }
  const args = scopeArguments({ unit, command, timeoutSeconds: 60 });
  assert.deepEqual(args.slice(-4), ["--", ...command]);
  assert.ok(args.includes("--expand-environment=no"));
  assert.ok(args.includes("--property=RuntimeMaxSec=60s"));
  assert.ok(args.includes("--property=MemoryMax=8G"));
  assert.ok(args.includes("--description=Paseo agent workload"));
});

test("scope stop refuses services, other slices, and this session's containing scope", () => {
  const properties = { Id: unit, ControlGroup: group };
  const selfCgroup = "0::/user.slice/unrelated.scope\n";
  assert.doesNotThrow(() => assertStoppable({ unit, properties, selfCgroup }));
  assert.throws(
    () => assertStoppable({ unit: "paseo.service", properties, selfCgroup }),
    /Not an agent scope/,
  );
  assert.throws(
    () =>
      assertStoppable({
        unit,
        properties: { ...properties, ControlGroup: `/other/${unit}` },
        selfCgroup,
      }),
    /not owned/,
  );
  assert.throws(
    () => assertStoppable({ unit, properties, selfCgroup: `0::${group}\n` }),
    /own scope/,
  );
  assert.throws(
    () => assertStoppable({ unit, properties, selfCgroup: `0::${group}/child\n` }),
    /own scope/,
  );
  assert.deepEqual(parseProperties("Id=x\nResult=a=b\n"), { Id: "x", Result: "a=b" });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function supervisor(workload, stop = async () => {}) {
  let parentExit;
  let signal;
  const events = [];
  const result = superviseScope({
    launch: () => workload,
    stop: async () => {
      events.push("stop");
      await stop();
    },
    watchParent: (callback) => {
      parentExit = callback;
      return () => events.push("unwatch");
    },
    signals: (callback) => {
      signal = callback;
      return () => events.push("unsubscribe");
    },
  });
  return { result, events, parentExit, signal };
}

test("natural workload exit cleans its scope before reporting success", async () => {
  const cleanup = deferred();
  const s = supervisor(Promise.resolve(17), () => cleanup.promise);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.events, ["unwatch", "unsubscribe", "stop"]);
  cleanup.resolve();
  assert.equal(await s.result, 17);
});

test("parent death and signals share idempotent cleanup", async () => {
  const workload = deferred();
  const s = supervisor(workload.promise);
  s.parentExit();
  s.signal();
  workload.resolve(0);
  assert.equal(await s.result, 143);
  assert.deepEqual(s.events, ["stop", "unwatch", "unsubscribe"]);
});

test("failed scope cleanup is reported instead of claiming success", async () => {
  const s = supervisor(Promise.resolve(0), async () => {
    throw new Error("stop denied");
  });
  await assert.rejects(s.result, /stop denied/);
});

// The real kernel flock proves cross-process admission and release after exit.
// Scope creation itself is exercised on a systemd host; no fake systemctl is used.
test(
  "two busy heavy-job slots queue the third command until a slot is released",
  { skip: process.platform !== "linux" },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paseo-job-slots-"));
    const holders = [];
    let queued;
    try {
      for (const slot of [1, 2]) {
        const holder = spawn(
          "bash",
          [
            "-c",
            'exec 8>"$1"; flock 8; echo ready; read -r finish',
            "holder",
            path.join(dir, `slot-${slot}`),
          ],
          { stdio: ["pipe", "pipe", "inherit"] },
        );
        holders.push(holder);
        await new Promise((resolve) => holder.stdout.once("data", resolve));
      }
      queued = spawn("bash", ["-c", JOB_SHELL, "job", dir, "printf", "admitted"], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      let output = "";
      queued.stdout.on("data", (data) => {
        output += data;
      });
      const exited = new Promise((resolve) => queued.once("close", resolve));
      // Prove the slots remain locked by the original holders while the job waits.
      for (const slot of [1, 2]) {
        assert.throws(() => execFileSync("flock", ["-n", path.join(dir, `slot-${slot}`), "true"]));
      }
      holders[0].stdin.end("finish\n");
      assert.equal(await exited, 0);
      assert.equal(output, "admitted");
    } finally {
      for (const holder of holders) holder.kill();
      queued?.kill();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("orphan detection checks start time so PID reuse cannot retain abandoned scopes", async () => {
  const owned = "paseo-agent-test-123-456-12345678-1234-1234-1234-123456789abc.scope";
  const stat = `123 (name with ) spaces) S ${Array(18).fill("0").join(" ")} 456 0`;
  assert.equal(processStartTicks(stat), "456");
  assert.equal(await ownerIsAlive(owned, async () => stat), true);
  assert.equal(await ownerIsAlive(owned, async () => stat.replace("456 0", "789 0")), false);
  assert.equal(
    await ownerIsAlive(owned, async () => {
      const e = new Error("gone");
      e.code = "ENOENT";
      throw e;
    }),
    false,
  );
  assert.equal(
    await ownerIsAlive("codex-123-456.scope", async () => {
      throw new Error("must not inspect legacy scope");
    }),
    true,
  );
  await assert.rejects(
    ownerIsAlive(owned, async () => {
      throw new Error("permission denied");
    }),
    /permission denied/,
  );
});

test("workloads refuse an aggregate slice with missing or unlimited budgets", () => {
  const finite = {
    MemoryMax: "17179869184",
    MemorySwapMax: "1073741824",
    TasksMax: "1800",
    CPUQuotaPerSecUSec: "5s",
  };
  assert.doesNotThrow(() => assertAggregateLimits(finite));
  assert.throws(() => assertAggregateLimits({}), /Configure a finite/);
  for (const field of Object.keys(finite)) {
    assert.throws(
      () => assertAggregateLimits({ ...finite, [field]: "infinity" }),
      /Configure a finite/,
    );
  }
});
