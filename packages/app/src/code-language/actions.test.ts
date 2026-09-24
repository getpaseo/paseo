import { expect, test } from "vitest";
import type {
  CodeDocument,
  CodeLocation,
  CodeQuery,
  CodeQueryResult,
} from "@getpaseo/protocol/code-language";
import { LanguageActions, type LanguageActionClock } from "./actions";
import { WorkspaceLanguage, type LanguageTransport } from "./model";

class ManualClock implements LanguageActionClock {
  pending = new Set<() => void | Promise<void>>();
  schedule(callback: () => void | Promise<void>) {
    this.pending.add(callback);
    return () => {
      this.pending.delete(callback);
    };
  }
  async advance() {
    const pending = [...this.pending];
    this.pending.clear();
    await Promise.all(pending.map((callback) => callback()));
  }
}
class MemoryTransport implements LanguageTransport {
  isConnected = true;
  result: CodeQueryResult | Promise<CodeQueryResult> = {
    kind: "hover",
    text: "number",
    range: null,
  };
  requests = 0;
  private notifyRequested: () => void = () => {};
  readonly requested = new Promise<void>((resolve) => {
    this.notifyRequested = resolve;
  });
  async syncCodeDocument(_document: CodeDocument) {}
  async queryCode(query: CodeQuery) {
    this.requests++;
    this.notifyRequested();
    return { result: await this.result, generation: "generation", version: query.version };
  }
  async cancelCodeQuery(_id: string) {}
  async getCodeSnippets(_cwd: string, _locations: CodeLocation[]) {
    return [];
  }
  subscribeConnectionStatus() {
    return () => {};
  }
}
const target = { path: "/repo/source.ts", position: { line: 0, character: 7 } };
const anchor = { x: 20, y: 30 };
function setup() {
  const transport = new MemoryTransport();
  const scope = new WorkspaceLanguage(transport, "/repo");
  const clock = new ManualClock();
  const locations: CodeLocation[] = [];
  const actions = new LanguageActions(scope, (location) => locations.push(location), clock);
  return { transport, scope, clock, locations, actions };
}

test("passive hover failures never open a popup or steal focus", async () => {
  const { transport, actions, clock, scope } = setup();
  transport.result = { kind: "error", message: "Unavailable" };
  actions.hover(target, anchor);
  await clock.advance();
  expect(actions.getSnapshot()).toEqual({ kind: "closed" });
  transport.isConnected = false;
  actions.hover(target, anchor);
  await clock.advance();
  expect(actions.getSnapshot()).toEqual({ kind: "closed" });
  scope.dispose();
});

test("closed dismissal cancels scheduled hover without publishing a redundant update", async () => {
  const { actions, clock, transport, scope } = setup();
  let changes = 0;
  actions.subscribe(() => changes++);
  actions.hover(target, anchor);
  actions.dismiss();
  actions.dismiss();
  await clock.advance();
  expect(changes).toBe(0);
  expect(transport.requests).toBe(0);
  scope.dispose();
});

test("moving into the hover card keeps its result and cancels a pending replacement", async () => {
  const { actions, clock, transport, scope } = setup();
  actions.hover(target, anchor);
  await clock.advance();
  const visible = actions.getSnapshot();
  expect(visible.kind).toBe("hover");
  actions.hover(target, { x: 21, y: 31 });
  expect(actions.getSnapshot()).toBe(visible);
  actions.hover({ ...target, position: { line: 1, character: 2 } }, anchor);
  expect(actions.getSnapshot()).toBe(visible);
  actions.holdHover();
  await clock.advance();
  expect(actions.getSnapshot()).toBe(visible);
  expect(transport.requests).toBe(1);
  actions.leaveHover();
  await clock.advance();
  expect(actions.getSnapshot()).toEqual({ kind: "closed" });
  scope.dispose();
});

test("deliberate inspect exposes stale recovery and restores keyboard focus on close", async () => {
  const { actions, locations, transport, scope } = setup();
  transport.result = { kind: "stale" };
  let focused = 0;
  await actions.run(target, "hover", anchor, () => focused++);
  expect(actions.getSnapshot()).toMatchObject({ kind: "hover", stale: true, interactive: true });
  actions.openCurrent();
  expect(locations).toEqual([
    { path: target.path, range: { start: target.position, end: target.position } },
  ]);
  await actions.run(target, "hover", anchor, () => focused++);
  actions.close();
  expect(focused).toBe(1);
  scope.dispose();
});

test("explicit usages keep an actionable failure and retry the original request", async () => {
  const { actions, transport, scope } = setup();
  transport.result = { kind: "error", message: "Unavailable" };
  await actions.run(target, "references");
  expect(actions.getSnapshot()).toEqual({
    kind: "popup",
    operation: "references",
    status: "error",
    locations: [],
  });
  transport.result = { kind: "locations", locations: [] };
  await actions.retry();
  expect(actions.getSnapshot()).toEqual({
    kind: "popup",
    operation: "references",
    status: "ready",
    locations: [],
  });
  scope.dispose();
});

test("dismissed hover ignores a late host response", async () => {
  const { actions, transport, clock, scope } = setup();
  let respond: (value: CodeQueryResult) => void = () => {};
  transport.result = new Promise((resolve) => {
    respond = resolve;
  });
  actions.hover(target, anchor);
  const pending = clock.advance();
  await transport.requested;
  expect(transport.requests).toBe(1);
  actions.dismiss();
  respond({ kind: "hover", text: "late", range: null });
  await pending;
  expect(actions.getSnapshot()).toEqual({ kind: "closed" });
  scope.dispose();
});
