import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

interface FixtureState {
  threadId: string;
  approvalsReviewer: "auto_review" | "user";
  approvalPolicy: "on-request";
  sandbox: { type: "workspaceWrite" };
  modelTurnsStarted: number;
  resumeOverridesIgnored: number;
}

const statePath = process.argv[2];
if (!statePath) throw new Error("Expected persisted reviewer fixture state path");

function readState(): FixtureState {
  return JSON.parse(readFileSync(statePath, "utf8")) as FixtureState;
}

function writeState(state: FixtureState): void {
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
}

function threadContext(state: FixtureState) {
  return {
    thread: { id: state.threadId, turns: [] },
    approvalPolicy: state.approvalPolicy,
    approvalsReviewer: state.approvalsReviewer,
    sandbox: state.sandbox,
  };
}

function reply(id: number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function notify(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (typeof request.id !== "number" || !request.method) return;
  const state = readState();
  switch (request.method) {
    case "initialize":
    case "collaborationMode/list":
    case "skills/list":
      reply(request.id, request.method === "initialize" ? {} : { data: [] });
      return;
    case "config/read":
      reply(request.id, { config: {} });
      return;
    case "thread/loaded/list":
      reply(request.id, { data: [state.threadId] });
      return;
    case "thread/resume":
      state.resumeOverridesIgnored += 1;
      writeState(state);
      reply(request.id, threadContext(state));
      return;
    case "thread/read":
      reply(request.id, threadContext(state));
      return;
    case "turn/start": {
      const reviewer = request.params?.approvalsReviewer;
      if (reviewer === "user" || reviewer === "auto_review") state.approvalsReviewer = reviewer;
      state.modelTurnsStarted += 1;
      writeState(state);
      reply(request.id, {});
      queueMicrotask(() => {
        notify("turn/started", { threadId: state.threadId, turn: { id: "fixture-turn" } });
        notify("turn/completed", {
          threadId: state.threadId,
          turn: { status: "completed", error: null },
        });
      });
      return;
    }
    default:
      process.stdout.write(
        `${JSON.stringify({ id: request.id, error: { message: `Unexpected request: ${request.method}` } })}\n`,
      );
  }
});
