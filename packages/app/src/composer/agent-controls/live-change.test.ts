import { describe, expect, it } from "vitest";
import { runLiveAgentControlChange } from "./live-change";

describe("runLiveAgentControlChange", () => {
  it("applies the live change before reporting success and persisting", async () => {
    const events: string[] = [];

    await runLiveAgentControlChange({
      apply: async () => {
        events.push("apply");
        return "notice";
      },
      onApplied: (notice) => events.push(notice),
      persist: async () => {
        events.push("persist");
      },
    });

    expect(events).toEqual(["apply", "notice", "persist"]);
  });

  it("does not persist when the live change is rejected", async () => {
    const events: string[] = [];
    const error = new Error("rejected");

    await expect(
      runLiveAgentControlChange({
        apply: async () => {
          events.push("apply");
          throw error;
        },
        persist: async () => {
          events.push("persist");
        },
      }),
    ).rejects.toBe(error);
    expect(events).toEqual(["apply"]);
  });

  it("keeps the successful live change observable when persistence fails", async () => {
    const events: string[] = [];
    const error = new Error("storage unavailable");

    await expect(
      runLiveAgentControlChange({
        apply: async () => {
          events.push("apply");
        },
        persist: async () => {
          events.push("persist");
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(events).toEqual(["apply", "persist"]);
  });
});
