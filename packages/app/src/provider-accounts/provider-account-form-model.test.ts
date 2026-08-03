import { describe, expect, it } from "vitest";
import {
  canAddProviderAccount,
  deriveProviderAccountId,
  groupProviderAccounts,
  openProviderAccountForm,
  resolveProviderAccountBaseId,
  type ProviderAccountFormSnapshot,
} from "./provider-account-form-model";

const SNAPSHOT: ProviderAccountFormSnapshot = {
  baseProviderId: "claude",
  baseProviderLabel: "Claude Code",
  existingProviderIds: ["claude", "codex", "junie"],
};

function openForm(overrides: Partial<ProviderAccountFormSnapshot> = {}) {
  return openProviderAccountForm({ ...SNAPSHOT, ...overrides });
}

describe("canAddProviderAccount", () => {
  it("accepts builtin providers that can be extended", () => {
    expect(canAddProviderAccount({ providerId: "claude", source: "builtin" })).toBe(true);
    expect(canAddProviderAccount({ providerId: "omp", source: "builtin" })).toBe(true);
  });

  it("rejects acp and custom rows", () => {
    expect(canAddProviderAccount({ providerId: "acp", source: "builtin" })).toBe(false);
    expect(canAddProviderAccount({ providerId: "junie", source: "custom" })).toBe(false);
    expect(canAddProviderAccount({ providerId: "junie", source: undefined })).toBe(false);
  });

  it("still offers builtins when the daemon omits source", () => {
    expect(canAddProviderAccount({ providerId: "claude", source: undefined })).toBe(true);
  });
});

describe("deriveProviderAccountId", () => {
  it("slugs a label into a legal provider id", () => {
    expect(deriveProviderAccountId("Claude (Work)")).toBe("claude-work");
    expect(deriveProviderAccountId("  Z.AI  ")).toBe("z-ai");
    expect(deriveProviderAccountId("2nd Account")).toBe("nd-account");
    expect(deriveProviderAccountId("!!!")).toBe("");
  });
});

describe("provider account presentation", () => {
  const providers = {
    "claude-work": { extends: "claude" },
    "codex-work": { extends: "codex" },
    catalog: { extends: "acp" },
  };

  it("resolves the built-in base used for an account icon", () => {
    expect(resolveProviderAccountBaseId("claude-work", providers)).toBe("claude");
    expect(resolveProviderAccountBaseId("catalog", providers)).toBeNull();
    expect(resolveProviderAccountBaseId("claude", providers)).toBeNull();
  });

  it("groups accounts immediately after their built-in base", () => {
    const items = ["claude", "codex", "copilot", "catalog", "claude-work", "codex-work"].map(
      (id) => ({ id }),
    );
    expect(groupProviderAccounts(items, providers).map((item) => item.id)).toEqual([
      "claude",
      "claude-work",
      "codex",
      "codex-work",
      "copilot",
      "catalog",
    ]);
  });
});

describe("provider account form model", () => {
  it("tracks the label until the id is edited by hand", () => {
    const model = openForm();
    model.setLabel("Claude Work");
    expect(model.getState().providerId).toBe("claude-work");
    expect(model.getState().providerIdEdited).toBe(false);

    model.setProviderId("work");
    model.setLabel("Claude Personal");
    expect(model.getState().providerId).toBe("work");
    expect(model.getState().providerIdEdited).toBe(true);
  });

  it("hides required errors until submit is attempted", () => {
    const model = openForm();
    expect(model.getState().labelError).toBeNull();
    expect(model.getState().providerIdError).toBeNull();
    expect(model.getState().canSubmit).toBe(false);

    model.markSubmitAttempted();
    expect(model.getState().labelError).toBe("required");
    expect(model.getState().providerIdError).toBe("required");
  });

  it("reports format and collision errors as soon as the id is touched", () => {
    const model = openForm();
    model.setProviderId("Claude Work");
    expect(model.getState().providerIdError).toBe("invalid");

    model.setProviderId("junie");
    expect(model.getState().providerIdError).toBe("taken");

    model.setProviderId("acp");
    expect(model.getState().providerIdError).toBe("taken");

    model.setProviderId("claude-work");
    expect(model.getState().providerIdError).toBeNull();
  });

  it("rejects env rows with a value but no key, and duplicate keys", () => {
    const model = openForm();
    model.setLabel("Claude Work");
    const [firstRow] = model.getState().envRows;
    if (!firstRow) throw new Error("expected a seeded env row");

    model.setEnvValue(firstRow.id, "sk-test");
    expect(model.getState().envErrors[firstRow.id]).toBe("keyRequired");
    expect(model.getState().canSubmit).toBe(false);

    model.setEnvKey(firstRow.id, "ANTHROPIC_API_KEY");
    expect(model.getState().envErrors).toEqual({});
    expect(model.getState().canSubmit).toBe(true);

    model.addEnvRow();
    const secondRow = model.getState().envRows[1];
    if (!secondRow) throw new Error("expected a second env row");
    model.setEnvKey(secondRow.id, "ANTHROPIC_API_KEY");
    expect(model.getState().envErrors[secondRow.id]).toBe("duplicate");
    expect(model.getState().canSubmit).toBe(false);

    model.removeEnvRow(secondRow.id);
    expect(model.getState().canSubmit).toBe(true);
  });

  it("keeps one env row after removing the last one", () => {
    const model = openForm();
    const [firstRow] = model.getState().envRows;
    if (!firstRow) throw new Error("expected a seeded env row");
    model.removeEnvRow(firstRow.id);
    expect(model.getState().envRows).toHaveLength(1);
  });

  it("builds the config patch and drops empty rows", () => {
    const model = openForm();
    model.setLabel("Claude (Work)");
    model.setDescription("  Work account  ");
    const [firstRow] = model.getState().envRows;
    if (!firstRow) throw new Error("expected a seeded env row");
    model.setEnvKey(firstRow.id, " ANTHROPIC_API_KEY ");
    model.setEnvValue(firstRow.id, " sk-test ");
    model.addEnvRow();

    expect(model.buildPatch()).toEqual({
      providers: {
        "claude-work": {
          extends: "claude",
          label: "Claude (Work)",
          description: "Work account",
          env: { ANTHROPIC_API_KEY: " sk-test " },
        },
      },
    });
  });

  it("omits description when blank and returns no patch while invalid", () => {
    const model = openForm();
    model.setLabel("Claude Work");
    expect(model.buildPatch()).toEqual({
      providers: {
        "claude-work": { extends: "claude", label: "Claude Work", env: {} },
      },
    });

    model.setProviderId("claude");
    expect(model.buildPatch()).toBeNull();
  });

  it("revalidates when the provider snapshot gains the id", () => {
    const model = openForm({ existingProviderIds: [] });
    model.setLabel("Claude Work");
    expect(model.getState().canSubmit).toBe(true);

    model.applyExistingProviderIds(["claude-work"]);
    model.markSubmitAttempted();
    expect(model.getState().providerIdError).toBe("taken");
    expect(model.getState().canSubmit).toBe(false);
  });

  it("blocks submission while submitting", () => {
    const model = openForm();
    model.setLabel("Claude Work");
    model.setSubmitting(true);
    expect(model.getState().canSubmit).toBe(false);
    model.setSubmitting(false);
    expect(model.getState().canSubmit).toBe(true);
  });

  it("opens an existing account with its editable fields and environment", () => {
    const model = openForm({
      existingProviderIds: ["claude", "claude-work", "claude-personal"],
      account: {
        providerId: "claude-work",
        config: {
          extends: "claude",
          label: "Claude (Work)",
          description: "Company account",
          env: { CLAUDE_CONFIG_DIR: "/work/claude", TOKEN: " keep spaces " },
        },
      },
    });

    expect(model.getState()).toMatchObject({
      isEditing: true,
      label: "Claude (Work)",
      providerId: "claude-work",
      providerIdError: null,
      description: "Company account",
      canSubmit: true,
    });
    expect(model.getState().envRows.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "CLAUDE_CONFIG_DIR", value: "/work/claude" },
      { key: "TOKEN", value: " keep spaces " },
    ]);
  });

  it("replaces an edited account exactly while preserving fields outside the form", () => {
    const model = openForm({
      existingProviderIds: ["claude", "claude-work"],
      account: {
        providerId: "claude-work",
        config: {
          extends: "claude",
          label: "Old label",
          description: "Delete me",
          env: { OLD_TOKEN: "old", KEEP: "old" },
          command: ["claude", "--work"],
          additionalModels: [{ id: "work-model", label: "Work model" }],
        },
      },
    });
    model.setLabel("Work");
    model.setDescription("   ");
    const [oldToken, keep] = model.getState().envRows;
    if (!oldToken || !keep) throw new Error("expected seeded environment rows");
    model.removeEnvRow(oldToken.id);
    model.setEnvValue(keep.id, "new");

    expect(model.buildPatch()).toEqual({
      replaceProviders: {
        "claude-work": {
          extends: "claude",
          label: "Work",
          env: { KEEP: "new" },
          command: ["claude", "--work"],
          additionalModels: [{ id: "work-model", label: "Work model" }],
        },
      },
    });
  });

  it("renames an account atomically and still rejects another account id", () => {
    const model = openForm({
      existingProviderIds: ["claude", "claude-work", "claude-personal"],
      account: {
        providerId: "claude-work",
        config: { extends: "claude", label: "Work", env: {} },
      },
    });

    model.setProviderId("claude-personal");
    expect(model.getState().providerIdError).toBe("taken");
    model.setProviderId("claude-company");
    expect(model.buildPatch()).toEqual({
      replaceProviders: {
        "claude-company": { extends: "claude", label: "Work", env: {} },
      },
      removeProviders: ["claude-work"],
    });
  });
});
