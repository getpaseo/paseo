import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PackRegistry } from "./pack.js";
import { TeamService, type TeamServiceOptions } from "./service.js";
import { TEAM_ROLE_LABEL, type TeamState } from "./types.js";

interface FakeRecord {
  id: string;
  provider: string;
  cwd: string;
  labels: Record<string, string>;
  archivedAt?: string | null;
  runtimeInfo?: { model: string };
}

function fakeHost() {
  const records = new Map<string, FakeRecord>();
  records.set("boss", {
    id: "boss",
    provider: "codex",
    cwd: "/repo",
    labels: {},
    runtimeInfo: { model: "gpt-6.1-sol" },
  });
  const created: FakeRecord[] = [];
  const prompts: Array<{ agentId: string; prompt: string }> = [];
  let n = 0;
  const options = {
    logger: pino({ level: "silent" }),
    packs: new PackRegistry(),
    timers: false,
    agentManager: {
      subscribe: () => () => {},
      getAgent: () => undefined,
      hasInFlightRun: () => false,
    },
    agentStorage: {
      get: async (id: string) => records.get(id) ?? null,
      list: async () => [...records.values()],
    },
    createAgent: async (input: {
      labels?: Record<string, string>;
      cwd?: string;
      worktree?: { worktreeName?: string };
    }) => {
      n += 1;
      const record: FakeRecord = {
        id: `agent-${n}`,
        provider: "codex",
        cwd: input.worktree
          ? `/repo/.worktrees/${input.worktree.worktreeName}`
          : (input.cwd ?? "/repo"),
        labels: input.labels ?? {},
      };
      records.set(record.id, record);
      created.push(record);
      return { snapshot: { id: record.id } };
    },
    sendPrompt: async (params: { agentId: string; prompt: unknown }) => {
      prompts.push({ agentId: params.agentId, prompt: String(params.prompt) });
      return { disposition: "turn_started" };
    },
  };
  const agentFor = (role: string, itemTitlePrefix?: string, state?: TeamState) =>
    created.find(
      (r) =>
        r.labels[TEAM_ROLE_LABEL] === role &&
        (!itemTitlePrefix ||
          state?.items[r.labels["pandaos.team.item"]!]?.title.startsWith(itemTitlePrefix)),
    )!;
  return { options, created, prompts, agentFor };
}

function makeService(root: string, host: ReturnType<typeof fakeHost>): TeamService {
  return new TeamService({ ...(host.options as unknown as TeamServiceOptions), storageRoot: root });
}

function itemByKey(state: TeamState, key: string) {
  return Object.values(state.items).find((i) => i.pack.key === key)!;
}

describe("TeamService", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pandaos-team-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs plan → implement → test → review → done and survives a daemon restart mid-work", async () => {
    const host = fakeHost();
    let svc = makeService(root, host);
    await svc.start();
    const started = await svc.startTeam({
      bossAgentId: "boss",
      title: "Pilot",
      objective: "Add a thing",
    });
    const teamId = started.team.id;
    await svc.dispatchAll();

    const po = host.agentFor("po");
    expect(po).toBeDefined();
    await svc.plan(po.id, [
      {
        key: "A",
        title: "First",
        objective: "do A",
        acceptanceCriteria: ["A works"],
        conflictsWith: ["B"],
      },
      { key: "B", title: "Second", objective: "do B", acceptanceCriteria: ["B works"] },
    ]);
    await svc.report(po.id, { outcome: "planned", summary: "Two items" });
    await svc.dispatchAll();

    let state = (await svc.status(teamId)).state;
    expect(itemByKey(state, "A").phase).toBe("implement");
    expect(itemByKey(state, "B").phase).toBe("ready"); // conflict with A waits

    const devA = host.agentFor("developer", "A", state);
    const createdBeforeRestart = host.created.length;

    // Daemon restart while the developer is running: nothing lost, nothing started twice.
    svc.stop();
    svc = makeService(root, host);
    await svc.start();
    await svc.dispatchAll();
    expect(host.created.length).toBe(createdBeforeRestart);
    expect(host.prompts.at(-1)).toMatchObject({ agentId: devA.id });
    expect(host.prompts.at(-1)!.prompt).toContain("daemon restarted");

    await svc.report(devA.id, {
      outcome: "done",
      summary: "Implemented A",
      artifacts: [{ kind: "commit", ref: "abc123" }],
    });
    await svc.dispatchAll();
    state = (await svc.status(teamId)).state;
    const testerA = host.agentFor("tester", "A", state);
    expect(testerA.cwd).toBe(devA.cwd); // tester works in the developer's worktree

    // Red test goes back to the same developer session.
    await svc.report(testerA.id, { outcome: "fail", summary: "A breaks on empty input" });
    await svc.dispatchAll();
    state = (await svc.status(teamId)).state;
    expect(itemByKey(state, "A").phase).toBe("implement");
    expect(host.prompts.at(-1)!.agentId).toBe(devA.id);
    expect(host.prompts.at(-1)!.prompt).toContain("A breaks on empty input");

    // The tester's old report is stale now and must not move the item.
    await expect(svc.report(testerA.id, { outcome: "pass", summary: "late" })).rejects.toThrow(
      /older state/,
    );

    await svc.report(devA.id, { outcome: "done", summary: "Fixed empty input" });
    await svc.dispatchAll();
    await svc.report(testerA.id, { outcome: "pass", summary: "All criteria met" });
    await svc.dispatchAll();
    state = (await svc.status(teamId)).state;
    const reviewerA = host.agentFor("reviewer", "A", state);
    await svc.report(reviewerA.id, { outcome: "changes", summary: "Missing error message" });
    await svc.dispatchAll();
    expect(itemByKey((await svc.status(teamId)).state, "A").phase).toBe("implement");
    await svc.report(devA.id, { outcome: "done", summary: "Added message" });
    await svc.dispatchAll();
    await svc.report(testerA.id, { outcome: "pass", summary: "ok" });
    await svc.dispatchAll();
    await svc.report(reviewerA.id, { outcome: "approve", summary: "ok" });
    await svc.dispatchAll();

    state = (await svc.status(teamId)).state;
    expect(itemByKey(state, "A").phase).toBe("done");
    expect(itemByKey(state, "B").phase).toBe("implement"); // freed by A finishing

    const devB = host.agentFor("developer", "B", state);
    await svc.report(devB.id, { outcome: "done", summary: "B" });
    await svc.dispatchAll();
    state = (await svc.status(teamId)).state;
    await svc.report(host.agentFor("tester", "B", state).id, { outcome: "pass", summary: "ok" });
    await svc.dispatchAll();
    state = (await svc.status(teamId)).state;
    await svc.report(host.agentFor("reviewer", "B", state).id, {
      outcome: "approve",
      summary: "ok",
    });
    await svc.dispatchAll();

    state = (await svc.status(teamId)).state;
    expect(state.items[state.team.rootItemId]!.phase).toBe("done");
    const bossNote = host.prompts.findLast((p) => p.agentId === "boss");
    expect(bossNote?.prompt).toContain('Team "Pilot" finished');
  });

  it("drops events of a commit whose state never landed", async () => {
    const host = fakeHost();
    const svc = makeService(root, host);
    await svc.start();
    const started = await svc.startTeam({ bossAgentId: "boss", title: "Crash", objective: "x" });
    await svc.dispatchAll();
    const state = (await svc.status(started.team.id)).state;
    const before = (await svc.status(state.team.id)).events.length;
    await appendFile(
      join(root, "teams", state.team.id, "events.jsonl"),
      `${JSON.stringify({ commit: state.commit + 1, at: new Date().toISOString(), type: "ghost", actor: { type: "runtime", id: "runtime" }, text: "ghost" })}\n`,
    );
    const fresh = makeService(root, host);
    const events = (await fresh.status(state.team.id)).events;
    expect(events.length).toBe(before);
    expect(events.some((e) => e.type === "ghost")).toBe(false);
  });

  it("pauses a team created with a different pack version", async () => {
    const host = fakeHost();
    const svc = makeService(root, host);
    await svc.start();
    const state = await svc.startTeam({ bossAgentId: "boss", title: "Versioned", objective: "x" });
    svc.stop();
    const packs = new PackRegistry();
    const pack = packs.get("software-basic")!;
    packs.register({ ...pack, version: pack.version + 1 });
    const upgraded = new TeamService({
      ...(host.options as unknown as TeamServiceOptions),
      storageRoot: root,
      packs,
    });
    await upgraded.start();
    const after = (await upgraded.status(state.team.id)).state;
    expect(after.team.status).toBe("paused");
    expect(after.team.pausedReason).toMatch(/pack-version-mismatch/);
  });
});
