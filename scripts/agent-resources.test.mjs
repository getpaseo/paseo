import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { once } from "node:events";
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
        holders.push(await holdSlot(path.join(dir, `slot-${slot}`)));
      }
      const ticks = processStartTicks(await readFile("/proc/self/stat", "utf8"));
      queued = spawn(
        "bash",
        ["-c", JOB_SHELL, "job", dir, String(process.pid), ticks, "printf", "admitted"],
        {
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
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
  for (const state of ["Z", "X"]) {
    assert.equal(await ownerIsAlive(owned, async () => stat.replace(") S ", `) ${state} `)), false);
  }
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

test(
  "a real unreaped zombie cannot keep its workload scope alive",
  { skip: process.platform !== "linux", timeout: 10_000 },
  async () => {
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `
    const { spawn } = require("node:child_process");
    const { readSync, writeSync } = require("node:fs");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    writeSync(1, String(child.pid));
    readSync(0, Buffer.alloc(1), 0, 1, null);
  `,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const closed = once(parent, "close");
    try {
      const [output] = await once(parent.stdout, "data");
      const pid = Number(output.toString());
      let stat;
      await waitFor(async () => {
        stat = await readFile(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z";
      }, "fixture child did not become a zombie");
      const owned = `paseo-agent-zombie-${pid}-${processStartTicks(stat)}-12345678-1234-1234-1234-123456789abc.scope`;
      assert.equal(await ownerIsAlive(owned), false);
    } finally {
      parent.stdin.end("\n");
      await closed;
    }
  },
);

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

async function waitFor(check, message) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function processIsRunning(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return false;
    throw error;
  }
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function holdSlot(file) {
  const child = spawn(
    "bash",
    ["-c", 'exec 8>"$1"; flock 8; echo ready; read -r finish', "holder", file],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  await once(child.stdout, "data");
  return child;
}

function queuedWrapper(slots, command, stdio = "ignore") {
  const launcher = `
    import { launchQueuedCommand } from ${JSON.stringify(new URL("./agent-resources.mjs", import.meta.url).href)};
    process.exitCode = await launchQueuedCommand({ slots: process.argv[1], command: process.argv.slice(2) });
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", launcher, slots, ...command], {
    stdio,
    detached: true,
  });
}

async function queuedShell(wrapper, slots) {
  let pid;
  await waitFor(async () => {
    const children = await readFile(`/proc/${wrapper.pid}/task/${wrapper.pid}/children`, "utf8");
    pid = Number(children.trim().split(/\s+/)[0]);
    if (!pid) return false;
    try {
      const files = await Promise.all([
        readlink(`/proc/${pid}/fd/8`),
        readlink(`/proc/${pid}/fd/9`),
      ]);
      return files[0] === path.join(slots, "slot-1") && files[1] === path.join(slots, "slot-2");
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }, "queue shell did not open both slot files");
  return pid;
}

for (const signal of ["SIGTERM", "SIGKILL"]) {
  test(
    `cancelling a queued wrapper with ${signal} never admits its command`,
    { skip: process.platform !== "linux", timeout: 10_000 },
    async (t) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "paseo-job-cancel-"));
      const holders = [];
      let wrapper;
      t.after(async () => {
        if (wrapper) {
          try {
            process.kill(-wrapper.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        for (const holder of holders) holder.stdin.end("finish\n");
        await rm(dir, { recursive: true, force: true });
      });
      for (const slot of [1, 2]) holders.push(await holdSlot(path.join(dir, `slot-${slot}`)));
      const marker = path.join(dir, "admitted");
      wrapper = queuedWrapper(dir, [
        process.execPath,
        "-e",
        'require("node:fs").writeFileSync(process.argv[1], "admitted")',
        marker,
      ]);
      const shell = await queuedShell(wrapper, dir);
      const exited = once(wrapper, "exit");
      wrapper.kill(signal);
      await exited;
      for (const holder of holders) holder.stdin.end("finish\n");
      await waitFor(async () => !(await processIsRunning(shell)), "cancelled queue shell survived");
      assert.equal(await exists(marker), false, "the cancelled command was admitted");
    },
  );

  test(
    `cancelling an admitted wrapper with ${signal} also cancels its command`,
    { skip: process.platform !== "linux", timeout: 10_000 },
    async (t) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "paseo-job-active-cancel-"));
      const ready = path.join(dir, "ready");
      const wrapper = queuedWrapper(dir, [
        process.execPath,
        "-e",
        'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)',
        ready,
      ]);
      t.after(async () => {
        try {
          process.kill(-wrapper.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        await rm(dir, { recursive: true, force: true });
      });
      await waitFor(() => exists(ready), "queued command was not admitted");
      const commandPid = Number(await readFile(ready, "utf8"));
      const shell = await queuedShell(wrapper, dir);
      const exited = once(wrapper, "exit");
      wrapper.kill(signal);
      await exited;
      await waitFor(
        async () => !(await processIsRunning(shell)),
        "queue shell survived cancellation",
      );
      await waitFor(
        async () => !(await processIsRunning(commandPid)),
        "admitted command survived cancellation",
      );
    },
  );
}

test(
  "queued commands retain stdin and their exit status",
  { skip: process.platform !== "linux", timeout: 10_000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paseo-job-stdio-"));
    const wrapper = queuedWrapper(
      dir,
      [
        process.execPath,
        "-e",
        'process.stdin.pipe(process.stdout); process.stdin.on("end", () => { process.exitCode = 17; })',
      ],
      ["pipe", "pipe", "inherit"],
    );
    t.after(async () => {
      try {
        process.kill(-wrapper.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await rm(dir, { recursive: true, force: true });
    });
    let output = "";
    wrapper.stdout.on("data", (data) => {
      output += data;
    });
    const closed = once(wrapper, "close");
    wrapper.stdin.end("literal input\n");
    assert.deepEqual(await closed, [17, null]);
    assert.equal(output, "literal input\n");
  },
);
