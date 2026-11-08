import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GoalConfig } from "@getpaseo/protocol/goal/types";
import { afterEach, beforeEach, expect, test } from "vitest";
import { GoalEventLog } from "./goal/event-log.js";
import { GoalStore } from "./goal/goal-store.js";
import {
  createTestAgentClients,
  type TestAgentClientOptions,
} from "./test-utils/fake-agent-client.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";

let root: string;
const open: { daemon: TestPaseoDaemon; client: DaemonClient }[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paseo-goal-e2e-"));
});

afterEach(async () => {
  for (const { daemon, client } of open.splice(0)) {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
  await rm(root, { recursive: true, force: true });
});

// Built-in providers without a fake client would probe real binaries on this machine. Copilot's
// catalog fetch can hang, and the branch auto-namer waits for every enabled provider's catalog
// before it picks a model, so it would never run before the goal finishes.
const providersWithoutFakeClient = {
  copilot: { enabled: false },
  pi: { enabled: false },
  omp: { enabled: false },
};

// Both daemons share one PASEO_HOME, so the second boot is a real restart.
async function boot(respond?: TestAgentClientOptions["respond"]): Promise<DaemonClient> {
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients(respond ? { respond } : {}),
    providerOverrides: providersWithoutFakeClient,
    paseoHomeRoot: root,
    cleanup: false,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await client.connect();
  open.push({ daemon, client });
  return client;
}

async function shutdown(client: DaemonClient): Promise<void> {
  const index = open.findIndex((entry) => entry.client === client);
  const [entry] = open.splice(index, 1);
  await entry?.client.close();
  await entry?.daemon.close();
}

const tasks = [
  { id: "a", title: "A", description: "", kind: "implement" as const, dependsOn: [] },
  { id: "b", title: "B", description: "", kind: "review" as const, dependsOn: ["a"] },
];

test("a goal and its history survive a daemon restart", async () => {
  const first = await boot();
  const created = await first.goalCreate({
    goalId: "g1",
    title: "Ship it",
    objective: "obj",
    criteria: ["tests pass"],
  });
  expect(created.error).toBeNull();
  await first.goalProposePlan({ goalId: "g1", tasks });
  const approved = await first.goalApprovePlan({ goalId: "g1" });
  expect(approved.goal?.status).toBe("executing");
  await shutdown(first);

  const second = await boot();
  const listed = await second.goalList();
  expect(listed.goals.map((g) => [g.id, g.status, g.lastSeq])).toEqual([["g1", "executing", 3]]);

  const inspected = await second.goalInspect("g1");
  expect(inspected.events.map((e) => [e.seq, e.type])).toEqual([
    [1, "goal.created"],
    [2, "plan.proposed"],
    [3, "plan.approved"],
  ]);
  expect(inspected.goal?.tasks.map((t) => [t.id, t.status])).toEqual([
    ["a", "pending"],
    ["b", "pending"],
  ]);
});

test("replaying a request after a restart does not duplicate events", async () => {
  const first = await boot();
  await first.goalCreate({ goalId: "g1", title: "T", objective: "", criteria: [] });
  await first.goalProposePlan({ goalId: "g1", tasks, eventId: "plan-1" });
  await shutdown(first);

  const second = await boot();
  const replay = await second.goalProposePlan({ goalId: "g1", tasks, eventId: "plan-1" });
  expect(replay.error).toBeNull();
  const inspected = await second.goalInspect("g1");
  expect(inspected.events).toHaveLength(2);
});

test("an illegal transition is reported to the client and changes nothing", async () => {
  const client = await boot();
  await client.goalCreate({ goalId: "g1", title: "T", objective: "", criteria: [] });
  await expect(client.goalApprovePlan({ goalId: "g1" })).rejects.toThrow(/awaiting_plan_approval/);
  expect((await client.goalInspect("g1")).events).toHaveLength(1);
});

test("a subscribed client is pushed goal changes, and an ended goal can be acknowledged", async () => {
  const client = await boot();
  const features = client.getLastServerInfoMessage()?.features;
  expect(features).toMatchObject({
    goalBudgets: true,
    goalUpdates: true,
    goalAcknowledge: true,
    goalThinking: true,
  });
  const pushed: { status: string; lastSeq: number; acknowledgedAt?: string | null }[] = [];
  const owner = client.observeGoalUpdates();
  owner.subscribe({
    snapshot: () => {},
    update: (message) => {
      if (message.type === "goal.update") pushed.push(message.payload.goal);
    },
  });
  await owner.ready;

  await client.goalCreate({ goalId: "g1", title: "T", objective: "", criteria: [] });
  await client.goalCancel({ goalId: "g1" });
  const acked = await client.goalAcknowledge({ goalId: "g1" });
  expect(acked.goal).toMatchObject({ status: "cancelled", acknowledgedAt: expect.any(String) });
  const last = await waitFor(
    async () => pushed.at(-1),
    (goal) => goal?.lastSeq === 3,
  );
  expect(last).toMatchObject({ status: "cancelled", acknowledgedAt: acked.goal?.acknowledgedAt });
  // Polling keeps working next to the push, and carries the same summary.
  const listed = await client.goalList();
  expect(listed.goals[0]).toMatchObject({
    acknowledgedAt: acked.goal?.acknowledgedAt,
    progress: { tasksTotal: 0, tasksDone: 0, tasksFailed: 0, tasksRunning: 0 },
  });
  await owner.release();
});

function createGitRepo(parent: string, branch = "main"): string {
  const repo = path.join(parent, "repo");
  execFileSync("git", ["init", "-b", branch, repo], { stdio: "pipe" });
  git(repo, "config", "user.email", "test@getpaseo.local");
  git(repo, "config", "user.name", "Paseo Test");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  writeFileSync(path.join(repo, "shared.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "initial");
  return repo;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, "add", "-A");
  // The scripted agent can be asked for the same reply more than once.
  if (git(cwd, "status", "--porcelain") === "") return;
  git(
    cwd,
    "-c",
    "user.name=Agent",
    "-c",
    "user.email=agent@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  );
}

const fenced = (value: unknown) => "Done.\n```json\n" + JSON.stringify(value) + "\n```";

/** Plays every agent role. `work` does the file changes for task prompts. */
function scriptedAgents(
  plan: unknown[],
  work: (prompt: string, cwd: string) => string,
  options: { nameBranches?: boolean } = {},
): TestAgentClientOptions["respond"] {
  let named = 0;
  return (prompt, config) => {
    // Paseo's branch auto-namer: when enabled it renames worktree branches like production does.
    if (options.nameBranches && prompt.includes("Generate a title and a git branch name")) {
      named += 1;
      return JSON.stringify({ title: `Auto named ${named}`, branch: `auto-named-${named}` });
    }
    if (prompt.includes("You are the Lead")) return fenced({ tasks: plan });
    if (prompt.includes("independent reviewer"))
      return fenced({ verdict: "approve", findings: [] });
    if (prompt.includes("You are the verifier")) {
      const ids = [...prompt.matchAll(/^- (\w+): /gm)].map((m) => m[1]);
      return fenced({ criteria: ids.map((id) => ({ id, met: true, evidence: `observed ${id}` })) });
    }
    // Only real task prompts are scripted. Paseo's own helper agents, such as the
    // branch auto-namer, run in the same worktrees and must be left alone.
    const isTask =
      prompt.includes("You are working on one task of the goal") ||
      prompt.includes("You are fixing your earlier work");
    return isTask ? work(prompt, config.cwd) : undefined;
  };
}

function managedConfig(cwd: string, extra: Partial<GoalConfig> = {}): GoalConfig {
  return {
    cwd,
    leadProvider: "claude",
    defaultProvider: "codex",
    maxParallel: 2,
    maxAttempts: 2,
    autoApprovePlan: true,
    notifyLead: false,
    ...extra,
  };
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting; last value: ${JSON.stringify(value).slice(0, 2000)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const isFinished = (r: Awaited<ReturnType<DaemonClient["goalInspect"]>>) =>
  r.goal?.status === "completed" || r.goal?.status === "failed";

const implementTask = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  description: `do ${id}`,
  kind: "implement",
  dependsOn: [],
  ...extra,
});

test("a goal runs through review and test to a merged integration branch, in real worktrees", async () => {
  const repo = createGitRepo(root);
  const plan = [implementTask("a"), implementTask("b", { dependsOn: ["a"], provider: "opencode" })];
  const client = await boot(
    scriptedAgents(plan, (prompt, cwd) => {
      if (/Your task \(implement\): Task a/.test(prompt)) {
        // The agent commits its own work.
        writeFileSync(path.join(cwd, "a.txt"), "from a\n");
        commitAll(cwd, "add a");
        return "built a";
      }
      // b builds on a, and leaves its change uncommitted for the Manager to capture.
      const sawA = existsSync(path.join(cwd, "a.txt"));
      writeFileSync(path.join(cwd, "b.txt"), sawA ? "b saw a\n" : "b did not see a\n");
      return "built b";
    }),
  );
  expect(
    (
      await client.goalCreate({
        goalId: "g1",
        title: "Ship",
        objective: "add a and b",
        criteria: ["a.txt and b.txt exist"],
        config: managedConfig(repo, { reviewProvider: "opencode", testCommand: "test -f a.txt" }),
      })
    ).error,
  ).toBeNull();

  const done = await waitFor(() => client.goalInspect("g1"), isFinished);
  const goal = done.goal;
  expect(goal?.failureReason).toBeNull();
  expect(goal?.status).toBe("completed");
  expect(goal?.criteria[0]).toMatchObject({ evidence: "observed c1" });

  // Explicit change sets pinned to real commits, merged in dependency order.
  expect(goal?.changeSets.map((c) => [c.taskId, c.status])).toEqual([
    ["a", "integrated"],
    ["b", "integrated"],
  ]);
  const integration = goal?.integration;
  expect(integration?.branch).toBe("paseo-goal/g1");
  for (const cs of goal?.changeSets ?? []) {
    expect(git(repo, "rev-parse", cs.headCommit)).toBe(cs.headCommit);
    expect(git(repo, "merge-base", "--is-ancestor", cs.headCommit, "paseo-goal/g1")).toBe("");
  }
  // b started from the integration branch, so it saw a's file.
  expect(readFileSync(path.join(integration?.cwd ?? "", "b.txt"), "utf8")).toBe("b saw a\n");
  expect(git(repo, "rev-parse", "paseo-goal/g1")).toBe(integration?.headCommit);
  expect(git(repo, "log", "--merges", "--format=%s", "paseo-goal/g1").split("\n")).toHaveLength(2);

  // The user's own checkout is untouched.
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(existsSync(path.join(repo, "a.txt"))).toBe(false);
}, 90_000);

test("a real merge conflict is aborted, resolved by the author in the same worktree, and integrated", async () => {
  const repo = createGitRepo(root);
  const plan = [implementTask("x"), implementTask("y")];
  const client = await boot(
    scriptedAgents(plan, (prompt, cwd) => {
      if (prompt.includes("You are fixing your earlier work")) {
        // The rework prompt tells the author to bring the integration branch in.
        const branch = /git merge ([^\s`]+)/.exec(prompt)?.[1] ?? "";
        try {
          git(cwd, "-c", "user.name=Agent", "-c", "user.email=a@example.com", "merge", branch);
        } catch {
          // Conflicted, as expected: resolve it.
        }
        writeFileSync(path.join(cwd, "shared.txt"), "both\n");
        commitAll(cwd, "resolve");
        return "resolved";
      }
      writeFileSync(
        path.join(cwd, "shared.txt"),
        /Your task \(implement\): Task x/.test(prompt) ? "x side\n" : "y side\n",
      );
      commitAll(cwd, "edit shared");
      return "edited";
    }),
  );
  await client.goalCreate({
    goalId: "g1",
    title: "Conflict",
    objective: "edit shared",
    criteria: ["it works"],
    config: managedConfig(repo),
  });

  const done = await waitFor(() => client.goalInspect("g1"), isFinished);
  const goal = done.goal;
  expect(goal?.failureReason).toBeNull();
  expect(goal?.status).toBe("completed");
  const statuses = goal?.changeSets.map((c) => c.status);
  expect(statuses).toContain("superseded");
  expect(goal?.changeSets.find((c) => c.status === "superseded")?.error).toMatch(
    /Conflicts in: shared.txt/,
  );
  expect(goal?.tasks.some((t) => t.rework?.reason === "conflict")).toBe(true);
  expect(readFileSync(path.join(goal?.integration?.cwd ?? "", "shared.txt"), "utf8")).toBe(
    "both\n",
  );
  expect(git(goal?.integration?.cwd ?? "", "status", "--porcelain")).toBe("");
}, 90_000);

test("a failing test command sends the change back, and the branch is never left broken", async () => {
  const repo = createGitRepo(root);
  const client = await boot(
    scriptedAgents([implementTask("a")], (prompt, cwd) => {
      const fixing = prompt.includes("You are fixing your earlier work");
      writeFileSync(path.join(cwd, "result.txt"), fixing ? "good\n" : "bad\n");
      commitAll(cwd, fixing ? "fix" : "first try");
      return "done";
    }),
  );
  await client.goalCreate({
    goalId: "g1",
    title: "Tests",
    objective: "make result good",
    criteria: ["it works"],
    config: managedConfig(repo, { testCommand: "grep -q good result.txt" }),
  });

  const done = await waitFor(() => client.goalInspect("g1"), isFinished);
  const goal = done.goal;
  expect(goal?.status).toBe("completed");
  expect(goal?.changeSets.map((c) => c.status)).toEqual(["superseded", "integrated"]);
  expect(goal?.changeSets[0]?.error).toMatch(/exited 1/);
  expect(readFileSync(path.join(goal?.integration?.cwd ?? "", "result.txt"), "utf8")).toBe(
    "good\n",
  );
  // The bad version never stayed on the integration branch.
  expect(git(repo, "log", "paseo-goal/g1", "--format=%s")).not.toContain("first try\n\n");
}, 90_000);

test("a merge that git refuses fails the goal, and retry merges it again without a new review", async () => {
  const repo = createGitRepo(root);
  const client = await boot(
    scriptedAgents([implementTask("a")], (_prompt, cwd) => {
      writeFileSync(path.join(cwd, "a.txt"), "from a\n");
      commitAll(cwd, "add a");
      return "built a";
    }),
  );
  await client.goalCreate({
    goalId: "g1",
    title: "Merge",
    objective: "add a",
    criteria: ["a.txt exists"],
    config: managedConfig(repo, { requireHumanApproval: true }),
  });
  const held = await waitFor(
    () => client.goalInspect("g1"),
    (r) => r.goal?.changeSets[0]?.status === "awaiting_human",
  );
  const integration = held.goal?.integration;
  const cs = held.goal?.changeSets[0];
  if (!integration || !cs) throw new Error("no integration or change set");
  // An unrelated untracked file does not block the merge; one the merge would overwrite does.
  writeFileSync(path.join(integration.cwd, "notes.local"), "tool state\n");
  writeFileSync(path.join(integration.cwd, "a.txt"), "in the way\n");
  await client.goalApproveChangeSet({ goalId: "g1", changeSetId: cs.id });

  const failed = (await waitFor(() => client.goalInspect("g1"), isFinished)).goal;
  expect(failed?.status).toBe("failed");
  expect(failed?.changeSets[0]).toMatchObject({
    status: "rejected",
    rejectionReason: "integration_failed",
  });
  expect(failed?.changeSets[0]?.error).toMatch(/untracked working tree files would be overwritten/);
  // Nothing was half merged, and the failed attempt reset the worktree, untracked files too.
  expect(git(integration.cwd, "rev-parse", "HEAD")).toBe(integration.headCommit);
  expect(existsSync(path.join(integration.cwd, "a.txt"))).toBe(false);

  await client.goalRetry({ goalId: "g1" });
  const done = await waitFor(
    () => client.goalInspect("g1"),
    (r) => r.goal?.status === "completed" || (r.goal?.status === "failed" && r.goal.reopens === 1),
  );
  expect(done.goal?.failureReason).toBeNull();
  expect(done.goal?.status).toBe("completed");
  expect(done.goal?.changeSets.map((c) => c.status)).toEqual(["integrated"]);
  expect(readFileSync(path.join(integration.cwd, "a.txt"), "utf8")).toBe("from a\n");
  const types = done.events.map((e) => e.type);
  expect(types.filter((t) => t === "changeset.integration_retried")).toHaveLength(1);
  expect(
    done.events.filter((e) => e.type === "changeset.transitioned" && e.to === "in_review"),
  ).toHaveLength(1);
}, 90_000);

test("a goal interrupted mid-run is recovered and finished after a restart", async () => {
  const first = await boot();
  const repo = createGitRepo(root);
  await shutdown(first);

  // Write the state a crash would leave: task a running, its run unfinished.
  const goalsDir = path.join(root, ".paseo", "goals");
  const store = new GoalStore(new GoalEventLog({ dir: goalsDir }));
  await store.recover();
  const dispatch = (type: string, extra: Record<string, unknown> = {}) =>
    store.dispatch("g1", { id: `seed-${type}`, goalId: "g1", type, ...extra } as never);
  await dispatch("goal.created", {
    title: "Ship",
    objective: "recover",
    criteria: [{ id: "c1", text: "it works" }],
    config: managedConfig(repo),
  });
  await dispatch("plan.proposed", { tasks: [implementTask("a")] });
  await dispatch("plan.approved");
  await dispatch("task.started", { taskId: "a" });
  await dispatch("run.started", { runId: "a-a1", taskId: "a", provider: "codex" });

  const second = await boot(
    scriptedAgents([], (_prompt, cwd) => {
      writeFileSync(path.join(cwd, "recovered.txt"), "yes\n");
      commitAll(cwd, "recovered");
      return "done";
    }),
  );
  const done = await waitFor(() => second.goalInspect("g1"), isFinished);
  expect(done.goal?.status).toBe("completed");
  expect(done.goal?.runs.map((r) => [r.id, r.status])).toEqual([
    ["a-a1", "interrupted"],
    ["a-a2", "succeeded"],
  ]);
  expect(done.goal?.changeSets.map((c) => c.status)).toEqual(["integrated"]);
}, 90_000);

test("the pipeline keeps working when Paseo's auto-namer renames the goal's branches", async () => {
  const repo = createGitRepo(root);
  const plan = [implementTask("a"), implementTask("b", { dependsOn: ["a"] })];
  const client = await boot(
    scriptedAgents(
      plan,
      (prompt, cwd) => {
        const isA = /Your task \(implement\): Task a/.test(prompt);
        writeFileSync(
          path.join(cwd, isA ? "a.txt" : "b.txt"),
          isA ? "a\n" : `saw a: ${existsSync(path.join(cwd, "a.txt"))}\n`,
        );
        return "done";
      },
      { nameBranches: true },
    ),
  );
  await client.goalCreate({
    goalId: "g1",
    title: "Renames",
    objective: "two dependent changes",
    criteria: ["both files exist"],
    config: managedConfig(repo),
  });

  const done = await waitFor(() => client.goalInspect("g1"), isFinished);
  const goal = done.goal;
  expect(goal?.failureReason).toBeNull();
  expect(goal?.status).toBe("completed");
  expect(goal?.changeSets.map((c) => c.status)).toEqual(["integrated", "integrated"]);
  expect(readFileSync(path.join(goal?.integration?.cwd ?? "", "b.txt"), "utf8")).toBe(
    "saw a: true\n",
  );
  // The namer renames the worktrees it is offered, but not the goal's integration branch.
  const currentBranch = git(goal?.integration?.cwd ?? "", "rev-parse", "--abbrev-ref", "HEAD");
  expect(currentBranch).toBe("paseo-goal/g1");
  // Non-vacuous: the namer was active and did rename the branches of the worktrees it was offered.
  expect(git(repo, "branch", "--list", "auto-named-*")).not.toBe("");
}, 90_000);

test("acceptance: heterogeneous agents build, review, test and integrate in isolated worktrees, and the full history survives a restart", async () => {
  const repo = createGitRepo(root);
  const plan = [
    implementTask("api", { provider: "codex" }),
    implementTask("ui", { provider: "opencode" }),
    implementTask("docs", { provider: "codex", dependsOn: ["api", "ui"] }),
  ];
  const agent = scriptedAgents(plan, (prompt, cwd) => {
    const name = /Your task \(implement\): Task (\w+)/.exec(prompt)?.[1] ?? "unknown";
    writeFileSync(path.join(cwd, `${name}.txt`), `${name} by ${path.basename(cwd)}\n`);
    commitAll(cwd, `add ${name}`);
    return `${name} done`;
  });
  const first = await boot(agent);
  await first.goalCreate({
    goalId: "g1",
    title: "Ship the feature",
    objective: "api, ui and docs",
    criteria: ["all three files exist", "tests pass"],
    config: managedConfig(repo, {
      reviewProvider: "opencode",
      testCommand: "test -f api.txt || test -f ui.txt || test -f docs.txt",
    }),
  });
  await waitFor(() => first.goalInspect("g1"), isFinished);
  const before = await first.goalInspect("g1");
  expect(before.goal?.failureReason).toBeNull();
  expect(before.goal?.status).toBe("completed");
  await shutdown(first);

  // After a restart the whole story is still there.
  const second = await boot(agent);
  const after = await second.goalInspect("g1");
  expect(after.goal).toEqual(before.goal);
  expect(after.events).toEqual(before.events);

  const goal = after.goal;
  // Different providers did the work.
  expect(new Set(goal?.runs.map((r) => r.provider))).toEqual(new Set(["codex", "opencode"]));
  expect(goal?.runs.find((r) => r.taskId === "ui")?.provider).toBe("opencode");
  // Each task ran in its own worktree, none in the repository checkout.
  const workspaces = goal?.runs.map((r) => r.workspaceId);
  expect(new Set(workspaces).size).toBe(workspaces?.length);
  const agents = await second.fetchAgents({ subscribe: {} });
  const goalAgents = agents.entries.filter((e) => e.agent.labels?.["paseo.goal-id"] === "g1");
  expect(goalAgents.length).toBeGreaterThanOrEqual(6);
  expect(goalAgents.every((e) => e.agent.cwd !== repo)).toBe(true);
  // Every change was reviewed and merged, and the criteria carry evidence.
  expect(goal?.changeSets.map((c) => c.status)).toEqual(["integrated", "integrated", "integrated"]);
  expect(goal?.criteria.every((c) => c.verifiedAt && c.evidence)).toBe(true);
  // The history is a gapless, ordered log of what happened.
  expect(after.events.map((e) => e.seq)).toEqual(after.events.map((_, i) => i + 1));
  expect(after.events.at(-1)?.type).toBe("goal.completed");
  for (const file of ["api.txt", "ui.txt", "docs.txt"]) {
    expect(existsSync(path.join(goal?.integration?.cwd ?? "", file))).toBe(true);
  }
  expect(git(repo, "status", "--porcelain")).toBe("");
}, 120_000);

test("a goal builds on the branch you started it from, even when the repository has no main branch", async () => {
  // The only branch is `trunk` and there is no origin, so there is no default branch to fall back on.
  const repo = createGitRepo(root, "trunk");
  git(repo, "checkout", "-b", "feature/x");
  writeFileSync(path.join(repo, "from-feature.txt"), "only on the feature branch\n");
  commitAll(repo, "feature work");
  const startCommit = git(repo, "rev-parse", "HEAD");

  const seen: Record<string, boolean> = {};
  const client = await boot(
    scriptedAgents([implementTask("a")], (_prompt, cwd) => {
      seen.workerSawFeature = existsSync(path.join(cwd, "from-feature.txt"));
      writeFileSync(path.join(cwd, "a.txt"), "a\n");
      commitAll(cwd, "add a");
      return "done";
    }),
  );
  await client.goalCreate({
    goalId: "g1",
    title: "Branch base",
    objective: "build on the feature branch",
    criteria: ["a.txt exists"],
    config: managedConfig(repo),
  });

  const done = await waitFor(() => client.goalInspect("g1"), isFinished);
  const goal = done.goal;
  expect(goal?.failureReason).toBeNull();
  expect(goal?.status).toBe("completed");
  expect(goal?.config?.baseCommit).toBe(startCommit);
  expect(goal?.integration?.baseCommit).toBe(startCommit);
  expect(seen.workerSawFeature).toBe(true);
  expect(existsSync(path.join(goal?.integration?.cwd ?? "", "from-feature.txt"))).toBe(true);
  // The checkout you were in is as you left it.
  expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/x");
  expect(git(repo, "status", "--porcelain")).toBe("");
}, 90_000);

test("creating a goal fails at once for a directory that is not a git repository", async () => {
  const client = await boot();
  await expect(
    client.goalCreate({
      goalId: "g1",
      title: "No repo",
      objective: "",
      criteria: ["x"],
      config: managedConfig(root),
    }),
  ).rejects.toThrow(/is not a git repository/);
}, 30_000);

test("creating a goal checks a role's thinking option against the provider's model catalog", async () => {
  const repo = createGitRepo(root);
  const client = await boot();
  // The fake codex catalog's default model lists no thinking options.
  await expect(
    client.goalCreate({
      goalId: "g1",
      title: "Thinking",
      objective: "",
      criteria: ["x"],
      config: managedConfig(repo, { workerThinking: "max" }),
    }),
  ).rejects.toThrow(
    /workerThinking "max" is not a thinking option of codex\/.+ Available: \(none\)/,
  );
  expect((await client.goalList()).goals).toEqual([]);
}, 30_000);

test("goal controls: a rejected plan is redone with the feedback, and a paused goal starts nothing until resumed", async () => {
  const repo = createGitRepo(root);
  const big = [implementTask("big")];
  const small = [implementTask("small")];
  const respond = scriptedAgents(big, (_prompt, cwd) => {
    writeFileSync(path.join(cwd, "small.txt"), "small\n");
    return "built small";
  });
  const client = await boot((prompt, config) =>
    prompt.includes("You are the Lead") && prompt.includes("Make it smaller")
      ? fenced({ tasks: small })
      : respond?.(prompt, config),
  );
  expect(client.getLastServerInfoMessage()?.features?.goalControls).toBe(true);
  await client.goalCreate({
    goalId: "g1",
    title: "Ship",
    objective: "add small.txt",
    criteria: ["small.txt exists"],
    config: managedConfig(repo, { autoApprovePlan: false, branchPrefix: "goals/e2e" }),
  });
  await waitFor(
    () => client.goalInspect("g1"),
    (r) => r.goal?.status === "awaiting_plan_approval",
  );
  await client.goalRejectPlan({ goalId: "g1", feedback: "Make it smaller" });
  const replanned = await waitFor(
    () => client.goalInspect("g1"),
    (r) => r.goal?.status === "awaiting_plan_approval" && r.goal.tasks[0]?.id === "small",
  );
  expect(replanned.goal?.planRejections?.map((r) => r.reason)).toEqual(["Make it smaller"]);

  await client.goalPause({ goalId: "g1" });
  await client.goalApprovePlan({ goalId: "g1" });
  await client.goalResume({ goalId: "g1" });
  const done = await waitFor(() => client.goalInspect("g1"), isFinished);
  expect(done.goal?.status).toBe("completed");
  expect(done.goal?.pausedAt).toBeNull();
  expect(done.goal?.integration?.branch).toBe("goals/e2e/g1");
  expect(done.goal?.usage?.totalTurns).toBeGreaterThan(0);

  // No worker run started while the goal was paused.
  const types = done.events.map((e) => e.type);
  const between = types.slice(types.indexOf("goal.paused"), types.indexOf("goal.resumed"));
  expect(between).not.toContain("run.started");
  expect(types).toContain("plan.rejected");
});

test("goal management: rename, priority, archive hides from the list, delete removes worktrees and keeps branches", async () => {
  const repo = createGitRepo(root);
  const client = await boot(
    scriptedAgents([implementTask("a")], (_prompt, cwd) => {
      writeFileSync(path.join(cwd, "a.txt"), "from a\n");
      return "built a";
    }),
  );
  expect(client.getLastServerInfoMessage()?.features).toMatchObject({ goalManagement: true });
  const pushed: { id: string; title: string; deleted: boolean }[] = [];
  const owner = client.observeGoalUpdates();
  owner.subscribe({
    snapshot: () => {},
    update: (message) => {
      if (message.type !== "goal.update") return;
      const { goal, deleted } = message.payload;
      pushed.push({ id: goal.id, title: goal.title, deleted: deleted === true });
    },
  });
  await owner.ready;

  await client.goalCreate({
    goalId: "g1",
    title: "Ship",
    objective: "add a",
    criteria: ["a.txt exists"],
    config: managedConfig(repo),
  });
  await client.goalCreate({
    goalId: "g2",
    title: "Notes",
    objective: "",
    criteria: [],
    priority: "low",
  });
  const done = await waitFor(() => client.goalInspect("g1"), isFinished);
  expect(done.goal?.status).toBe("completed");
  const integration = done.goal?.integration;
  expect(integration && existsSync(integration.cwd)).toBe(true);

  const renamed = await client.goalRename({ goalId: "g1", title: "Ship a" });
  expect(renamed.goal?.title).toBe("Ship a");
  await client.goalSetPriority({ goalId: "g2", priority: "high" });
  expect((await client.goalList()).goals.map((g) => g.id)).toEqual(["g2", "g1"]);
  expect((await client.goalList({ query: "ship A" })).goals.map((g) => g.id)).toEqual(["g1"]);
  expect((await client.goalList({ cwd: repo })).goals.map((g) => g.id)).toEqual(["g1"]);

  // A live goal must be stopped first.
  await expect(client.goalArchive({ goalId: "g2" })).rejects.toThrow(/stop it before/);
  const archived = await client.goalArchive({ goalId: "g1" });
  expect(archived.goal?.archivedAt).toEqual(expect.any(String));
  expect((await client.goalList()).goals.map((g) => g.id)).toEqual(["g2"]);
  expect((await client.goalList({ archived: "only" })).goals.map((g) => g.id)).toEqual(["g1"]);
  const inspected = await client.goalInspect("g1");
  expect(inspected.events.map((e) => e.type)).toEqual(
    expect.arrayContaining(["goal.renamed", "goal.archived"]),
  );

  await expect(client.goalDelete({ goalId: "g2" })).rejects.toThrow(/stop it before/);
  const deleted = await client.goalDelete({ goalId: "g1" });
  expect(deleted).toMatchObject({ goalId: "g1", deleted: true, error: null });
  expect(deleted.retained).toContainEqual({
    kind: "branch",
    name: "paseo-goal/g1",
    reason: "Branches are never deleted",
  });
  expect(deleted.retained.filter((r) => r.kind === "worktree")).toEqual([]);
  // The integration branch and its commits stay; the worktree is gone.
  expect(git(repo, "rev-parse", "paseo-goal/g1")).toBe(integration?.headCommit);
  expect(existsSync(integration?.cwd ?? "")).toBe(false);
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect((await client.goalList({ archived: "include" })).goals.map((g) => g.id)).toEqual(["g2"]);
  expect((await client.goalDelete({ goalId: "g1" })).deleted).toBe(false);
  await waitFor(
    async () => pushed.filter((p) => p.deleted),
    (list) => list.length === 1,
  );
  expect(pushed.filter((p) => p.deleted)).toEqual([{ id: "g1", title: "Ship a", deleted: true }]);
  await owner.release();

  // A deleted goal stays deleted across a restart.
  await shutdown(client);
  const after = await boot();
  expect((await after.goalList({ archived: "include" })).goals.map((g) => g.id)).toEqual(["g2"]);
  expect((await after.goalList()).goals[0]?.priority).toBe("high");
}, 90_000);

test("config edits: settings change after creation, and a goal that failed while planning is reopened with a fresh Lead", async () => {
  const repo = createGitRepo(root);
  let planning: "bad" | "good" = "bad";
  const respond = scriptedAgents([implementTask("a")], (_prompt, cwd) => {
    writeFileSync(path.join(cwd, "a.txt"), "from a\n");
    return "built a";
  });
  const client = await boot((prompt, config) => {
    const lead = prompt.includes("You are the Lead") || prompt.includes("could not be used");
    if (lead && planning === "bad") return "I could not decide on a plan.";
    return respond?.(prompt, config);
  });
  expect(client.getLastServerInfoMessage()?.features?.goalConfigEdit).toBe(true);

  // Without a policy the goal records the new default.
  const created = await client.goalCreate({
    goalId: "g1",
    title: "Ship",
    objective: "add a.txt",
    criteria: ["a.txt exists"],
    config: managedConfig(repo),
  });
  expect(created.goal?.config?.onPermissionRequest).toBe("wait");
  const failed = await waitFor(() => client.goalInspect("g1"), isFinished);
  expect(failed.goal?.status).toBe("failed");
  expect(failed.goal?.failureReason).toMatch(/Lead did not produce a valid plan/);
  expect(failed.goal?.tasks).toEqual([]);
  const firstLead = failed.goal?.leadAgentId;

  // Settings change on the failed goal; fixed fields are not part of the request. The test
  // "codex" lists no auto-review mode, so `auto` would be refused for it.
  const edited = await client.goalUpdateConfig({
    goalId: "g1",
    changes: { onPermissionRequest: "fail", maxParallel: 1, limits: { maxRuns: 30 } },
  });
  expect(edited.goal?.config).toMatchObject({
    onPermissionRequest: "fail",
    maxParallel: 1,
    limits: { maxRuns: 30 },
    leadProvider: "claude",
  });

  planning = "good";
  await client.goalRetry({ goalId: "g1" });
  const done = await waitFor(() => client.goalInspect("g1"), isFinished);
  expect(done.goal?.status).toBe("completed");
  expect(done.goal?.reopens).toBe(1);
  expect(done.goal?.leadAgentId).not.toBe(firstLead);
  const types = done.events.map((e) => e.type);
  expect(types).toContain("goal.config_updated");
  expect(types).toContain("goal.reopened");
  expect(types.filter((t) => t === "lead.attached")).toHaveLength(2);
}, 60_000);

test("usage breakdown: every agent's turns are listed by role and add up to the goal's usage", async () => {
  const repo = createGitRepo(root);
  const respond = scriptedAgents([implementTask("a")], (_prompt, cwd) => {
    writeFileSync(path.join(cwd, "a.txt"), "from a\n");
    return "built a";
  });
  const client = await boot(respond);
  expect(client.getLastServerInfoMessage()?.features?.goalUsageBreakdown).toBe(true);
  const pushed: { usageBreakdown?: unknown[] }[] = [];
  const owner = client.observeGoalUpdates();
  owner.subscribe({
    snapshot: () => {},
    update: (message) => {
      if (message.type === "goal.update") pushed.push(message.payload.goal);
    },
  });
  await owner.ready;

  await client.goalCreate({
    goalId: "g1",
    title: "Ship",
    objective: "add a.txt",
    criteria: ["a.txt exists"],
    config: managedConfig(repo),
  });
  const done = await waitFor(() => client.goalInspect("g1"), isFinished);
  expect(done.goal?.status).toBe("completed");
  const usage = done.goal?.usage;
  const breakdown = done.goal?.usageBreakdown ?? [];
  expect(usage?.totalTurns).toBeGreaterThan(0);
  expect(breakdown.map((e) => e.role)).toEqual(
    expect.arrayContaining(["lead", "worker", "reviewer", "verifier"]),
  );
  expect(breakdown.find((e) => e.role === "worker")).toMatchObject({
    taskId: "a",
    runId: expect.any(String),
    provider: expect.any(String),
  });
  expect(breakdown.find((e) => e.role === "reviewer")?.changeSetId).toEqual(expect.any(String));
  const sum = (key: "totalTurns" | "totalTokens") =>
    breakdown.reduce((total, e) => total + e.usage[key], 0);
  expect(sum("totalTurns")).toBe(usage?.totalTurns);
  expect(sum("totalTokens")).toBe(usage?.totalTokens);
  const byRole = Object.values(done.goal?.usageByRole ?? {});
  expect(byRole.reduce((total, u) => total + (u?.totalTurns ?? 0), 0)).toBe(usage?.totalTurns);
  // The pushed summary carries the breakdown to a client that declared the capability.
  await waitFor(
    async () => pushed.at(-1),
    (goal) => (goal?.usageBreakdown?.length ?? 0) === breakdown.length,
  );
  await owner.release();
}, 60_000);

test("the worker run cap is read and changed through the daemon config, and a bad value is refused", async () => {
  const client = await boot();
  expect(client.getLastServerInfoMessage()?.features?.goalConcurrencyConfig).toBe(true);
  expect((await client.getDaemonConfig()).config.goals?.maxConcurrentRuns).toBeUndefined();

  const patched = await client.patchDaemonConfig({ goals: { maxConcurrentRuns: 6 } });
  expect(patched.config.goals?.maxConcurrentRuns).toBe(6);
  expect((await client.getDaemonConfig()).config.goals?.maxConcurrentRuns).toBe(6);

  await expect(client.patchDaemonConfig({ goals: { maxConcurrentRuns: 0 } })).rejects.toThrow();
  expect((await client.getDaemonConfig()).config.goals?.maxConcurrentRuns).toBe(6);
});
