import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { applyTeamEdit, openTeamForm, removeTeam } from "./team-form-model";

const entries: ProviderSnapshotEntry[] = [
  {
    provider: "codex",
    status: "ready",
    enabled: true,
    label: "Codex",
    defaultModeId: "auto",
    models: [
      { provider: "codex", id: "codex-small", label: "Small" },
      { provider: "codex", id: "codex-large", label: "Large", isDefault: true },
    ],
    modes: [
      { id: "read-only", label: "Read only" },
      { id: "auto", label: "Auto" },
    ],
  },
];

describe("openTeamForm", () => {
  it("starts create mode with one empty role and cannot submit", () => {
    const form = openTeamForm({ mode: "create", existingTeamNames: [] });
    expect(form.getState().roles).toHaveLength(1);
    expect(form.getState().canSubmit).toBe(false);
    expect(form.getState().nameIssue).toBe("required");
  });

  it("builds a provider role with the catalog's default model and mode", () => {
    const form = openTeamForm({ mode: "create", existingTeamNames: [] });
    form.applyProviderCatalog(entries);
    const key = form.getState().roles[0]?.key ?? "";
    form.setName(" ship ");
    form.setRoleName(key, "implementer");
    form.setRoleDescription(key, "Writes the code.");
    form.setRoleAgent(key, "provider:codex", { label: "Codex" });
    form.setRoleIsolation(key, "worktree");

    expect(form.getState().submitValue).toEqual({
      name: "ship",
      team: {
        roles: {
          implementer: {
            description: "Writes the code.",
            provider: "codex",
            model: "codex-large",
            modeId: "auto",
            isolation: "worktree",
          },
        },
      },
    });
  });

  it("flags duplicate team and role names", () => {
    const form = openTeamForm({ mode: "create", existingTeamNames: ["ship"] });
    form.setName("ship");
    form.addRole();
    const [first, second] = form.getState().roles;
    form.setRoleName(first?.key ?? "", "dev");
    form.setRoleName(second?.key ?? "", " dev ");

    const state = form.getState();
    expect(state.nameIssue).toBe("duplicate");
    expect(state.roleIssues[second?.key ?? ""]?.name).toBe("duplicate");
    expect(state.canSubmit).toBe(false);
  });

  it("keeps the edited team's own name and preserves unknown and untouched fields", () => {
    const form = openTeamForm({
      mode: "edit",
      teamName: "ship",
      existingTeamNames: ["ship", "other"],
      team: {
        description: "Ship it.",
        futureTeamField: 1,
        roles: {
          reviewer: {
            description: "Reviews.",
            provider: "codex",
            model: "codex-small",
            thinkingOptionId: "high",
            futureRoleField: "x",
          },
          researcher: { description: "Reads docs.", profile: "Gemini researcher" },
        },
      },
    });
    form.applyProfiles([{ id: "p1", name: "Gemini researcher", provider: "gemini" }]);

    expect(form.getState().nameIssue).toBeNull();
    expect(form.getState().submitValue).toEqual({
      name: "ship",
      team: {
        description: "Ship it.",
        futureTeamField: 1,
        roles: {
          reviewer: {
            description: "Reviews.",
            provider: "codex",
            model: "codex-small",
            thinkingOptionId: "high",
            futureRoleField: "x",
          },
          researcher: { description: "Reads docs.", profile: "p1" },
        },
      },
    });
  });

  it("drops the stored thinking option when the model changes", () => {
    const form = openTeamForm({
      mode: "edit",
      teamName: "ship",
      existingTeamNames: ["ship"],
      team: {
        roles: {
          reviewer: {
            description: "Reviews.",
            provider: "codex",
            model: "codex-small",
            thinkingOptionId: "high",
          },
        },
      },
    });
    const key = form.getState().roles[0]?.key ?? "";
    form.setRoleModel(key, "codex-large", { label: "Large" });

    expect(form.getState().submitValue?.team.roles["reviewer"]).toEqual({
      description: "Reviews.",
      provider: "codex",
      model: "codex-large",
    });
  });
});

describe("applyTeamEdit", () => {
  const role = { description: "x", provider: "claude" };

  it("renames a team in place", () => {
    const next = applyTeamEdit({
      teams: { a: { roles: { r: role } }, b: { roles: { r: role } } },
      originalName: "a",
      name: "c",
      team: { roles: { r: role } },
    });
    expect(Object.keys(next)).toEqual(["c", "b"]);
  });

  it("appends a new team", () => {
    const next = applyTeamEdit({
      teams: { a: { roles: { r: role } } },
      originalName: null,
      name: "b",
      team: { roles: { r: role } },
    });
    expect(Object.keys(next)).toEqual(["a", "b"]);
  });

  it("removes a team", () => {
    expect(removeTeam({ a: { roles: { r: role } }, b: { roles: { r: role } } }, "a")).toEqual({
      b: { roles: { r: role } },
    });
  });
});
