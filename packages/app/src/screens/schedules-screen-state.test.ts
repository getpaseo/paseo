import { describe, expect, it } from "vitest";
import {
  resolveSchedulesCreateIntent,
  resolveSchedulesScreenBodyState,
} from "./schedules-screen-state";

describe("resolveSchedulesScreenBodyState", () => {
  it("routes failed loading state to the retry UI instead of the spinner", () => {
    expect(
      resolveSchedulesScreenBodyState({
        loadState: { status: "loading" },
        showLoadError: true,
      }),
    ).toEqual({ kind: "load-error" });
  });
});

describe("resolveSchedulesCreateIntent", () => {
  it("prefills the create form when the route names a host and an agent", () => {
    expect(resolveSchedulesCreateIntent({ serverId: "host-a", agentId: "agent-1" })).toEqual({
      kind: "agent",
      serverId: "host-a",
      agentId: "agent-1",
    });
  });

  it("ignores a half-specified link", () => {
    expect(resolveSchedulesCreateIntent({ serverId: "host-a" })).toEqual({ kind: "none" });
    expect(resolveSchedulesCreateIntent({ agentId: "agent-1" })).toEqual({ kind: "none" });
    expect(resolveSchedulesCreateIntent({ serverId: "  ", agentId: "agent-1" })).toEqual({
      kind: "none",
    });
    expect(resolveSchedulesCreateIntent({})).toEqual({ kind: "none" });
  });
});
