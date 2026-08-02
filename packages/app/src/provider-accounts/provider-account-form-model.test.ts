import { describe, expect, it } from "vitest";
import {
  canAddProviderAccount,
  deriveProviderAccountId,
  openProviderAccountForm,
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

  it("rejects acp, custom rows, and unknown sources", () => {
    expect(canAddProviderAccount({ providerId: "acp", source: "builtin" })).toBe(false);
    expect(canAddProviderAccount({ providerId: "junie", source: "custom" })).toBe(false);
    expect(canAddProviderAccount({ providerId: "claude", source: undefined })).toBe(false);
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
          env: { ANTHROPIC_API_KEY: "sk-test" },
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
});
