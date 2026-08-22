import { describe, expect, it, vi } from "vitest";

import { migrateLegacyAgentSkillsSelection } from "./legacy-migration";

describe("legacy agent skills migration", () => {
  it("deletes the legacy file only after the daemon confirms persistence", async () => {
    const selection = { mode: "custom" as const, skills: ["paseo"] };
    const order: string[] = [];
    const client = {
      importLegacyAgentSkillsSelection: vi.fn(async () => {
        order.push("persist");
      }),
    };
    const remove = vi.fn(async () => {
      order.push("delete");
    });

    await expect(
      migrateLegacyAgentSkillsSelection(client, async () => selection, remove),
    ).resolves.toBe(true);
    expect(client.importLegacyAgentSkillsSelection).toHaveBeenCalledWith(selection);
    expect(order).toEqual(["persist", "delete"]);
  });

  it("retains the legacy file when daemon persistence fails", async () => {
    const failure = new Error("offline");
    const client = { importLegacyAgentSkillsSelection: vi.fn(async () => Promise.reject(failure)) };
    const remove = vi.fn();

    await expect(
      migrateLegacyAgentSkillsSelection(client, async () => ({ mode: "all" }), remove),
    ).rejects.toBe(failure);
    expect(remove).not.toHaveBeenCalled();
  });

  it("does nothing when no legacy file remains", async () => {
    const client = { importLegacyAgentSkillsSelection: vi.fn() };
    const remove = vi.fn();

    await expect(migrateLegacyAgentSkillsSelection(client, async () => null, remove)).resolves.toBe(
      false,
    );
    expect(client.importLegacyAgentSkillsSelection).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
