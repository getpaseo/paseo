import { describe, expect, it } from "vitest";
import { openProjectGroupCreateForm } from "./create-form-model";
import type { ProjectGroupOutcome } from "./index";

const MEMBERS = [
  { viewKey: "a", name: "Alpha" },
  { viewKey: "b", name: "Beta" },
  { viewKey: "c", name: "Gamma" },
];

function applied(): Promise<ProjectGroupOutcome> {
  return Promise.resolve({ kind: "applied", serverIds: ["host-1"] });
}

function describeOutcome(outcome: ProjectGroupOutcome): string | null {
  return outcome.kind === "applied" ? null : "failed";
}

describe("openProjectGroupCreateForm", () => {
  it("preselects only the view keys that belong to a known member", () => {
    const form = openProjectGroupCreateForm({
      members: MEMBERS,
      preselectedViewKeys: ["a", "unknown"],
      submit: applied,
      describeOutcome,
    });
    expect(form.getState().selected).toEqual(new Set(["a"]));
  });

  it("toggles a member on and off", () => {
    const form = openProjectGroupCreateForm({
      members: MEMBERS,
      preselectedViewKeys: [],
      submit: applied,
      describeOutcome,
    });
    form.toggleMember("b");
    expect(form.getState().selected).toEqual(new Set(["b"]));
    form.toggleMember("b");
    expect(form.getState().selected).toEqual(new Set());
  });

  it("ignores toggling a view key that is not a known member", () => {
    const form = openProjectGroupCreateForm({
      members: MEMBERS,
      preselectedViewKeys: [],
      submit: applied,
      describeOutcome,
    });
    form.toggleMember("unknown");
    expect(form.getState().selected).toEqual(new Set());
  });

  it("can submit only once a name is set and at least one member is selected", () => {
    const form = openProjectGroupCreateForm({
      members: MEMBERS,
      preselectedViewKeys: [],
      submit: applied,
      describeOutcome,
    });
    expect(form.getState().canSubmit).toBe(false);

    form.setName("Client X");
    expect(form.getState().canSubmit).toBe(false);

    form.toggleMember("a");
    expect(form.getState().canSubmit).toBe(true);

    form.setName("   ");
    expect(form.getState().normalizedName).toBeNull();
    expect(form.getState().canSubmit).toBe(false);
  });

  it("returns a referentially stable snapshot between changes", () => {
    const form = openProjectGroupCreateForm({
      members: MEMBERS,
      preselectedViewKeys: [],
      submit: applied,
      describeOutcome,
    });
    const first = form.getState();
    expect(form.getState()).toBe(first);
    form.toggleMember("a");
    const second = form.getState();
    expect(second).not.toBe(first);
    expect(form.getState()).toBe(second);
  });

  it("does nothing and resolves false while canSubmit is false", async () => {
    let calls = 0;
    const form = openProjectGroupCreateForm({
      members: MEMBERS,
      preselectedViewKeys: [],
      submit: () => {
        calls += 1;
        return applied();
      },
      describeOutcome,
    });
    expect(await form.submit()).toBe(false);
    expect(calls).toBe(0);
  });

  it("sets an error from a non-applied outcome and resolves false", async () => {
    const form = openProjectGroupCreateForm({
      members: MEMBERS,
      preselectedViewKeys: ["a"],
      submit: () => Promise.resolve({ kind: "failed", serverIds: ["host-1"] }),
      describeOutcome,
    });
    form.setName("Client X");
    const result = await form.submit();
    expect(result).toBe(false);
    expect(form.getState().error).toBe("failed");
    expect(form.getState().pending).toBe(false);
  });

  it("resolves true and clears pending on an applied outcome", async () => {
    const form = openProjectGroupCreateForm({
      members: MEMBERS,
      preselectedViewKeys: ["a"],
      submit: applied,
      describeOutcome,
    });
    form.setName("Client X");
    const result = await form.submit();
    expect(result).toBe(true);
    expect(form.getState().error).toBeNull();
    expect(form.getState().pending).toBe(false);
  });

  it("ignores a second submit while the first is in flight", async () => {
    let calls = 0;
    let resolveFirst: (() => void) | undefined;
    const form = openProjectGroupCreateForm({
      members: MEMBERS,
      preselectedViewKeys: ["a"],
      submit: () => {
        calls += 1;
        return new Promise<ProjectGroupOutcome>((resolve) => {
          resolveFirst = () => resolve({ kind: "applied", serverIds: ["host-1"] });
        });
      },
      describeOutcome,
    });
    form.setName("Client X");

    const first = form.submit();
    expect(form.getState().pending).toBe(true);
    const second = form.submit();

    resolveFirst?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(true);
    expect(secondResult).toBe(false);
    expect(calls).toBe(1);
  });

  it("passes every selected view key and the trimmed name to submit", async () => {
    const calls: Array<{ viewKeys: string[]; group: string }> = [];
    const form = openProjectGroupCreateForm({
      members: MEMBERS,
      preselectedViewKeys: [],
      submit: (submitInput) => {
        calls.push(submitInput);
        return applied();
      },
      describeOutcome,
    });
    form.setName("  Client X  ");
    form.toggleMember("a");
    form.toggleMember("b");
    await form.submit();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.group).toBe("Client X");
    expect(new Set(calls[0]?.viewKeys)).toEqual(new Set(["a", "b"]));
  });
});
