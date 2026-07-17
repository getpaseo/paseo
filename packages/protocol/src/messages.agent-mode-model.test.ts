import { describe, expect, it } from "vitest";
import { ProviderSnapshotEntrySchema } from "./messages";

// AgentMode.model is an additive, optional field. These tests pin both-direction
// back-compat: a new daemon may send a mode carrying `model`, and an old-shaped
// mode (no `model`) must still parse. AgentModeSchema is exercised through the
// exported ProviderSnapshotEntrySchema.modes array.
describe("AgentMode model back-compat", () => {
  it("parses a mode without a model (old client / old daemon)", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "example",
      status: "ready",
      label: "Example",
      modes: [{ id: "build", label: "Build" }],
    });

    expect(parsed.modes?.[0]).toEqual({ id: "build", label: "Build" });
    expect(parsed.modes?.[0]?.model).toBeUndefined();
  });

  it("parses a mode carrying a model (new daemon → any client)", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "example",
      status: "ready",
      label: "Example",
      modes: [{ id: "build", label: "Build", model: "anthropic/claude-sonnet-4" }],
    });

    expect(parsed.modes?.[0]?.model).toBe("anthropic/claude-sonnet-4");
  });
});
