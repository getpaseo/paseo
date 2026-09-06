import { describe, expect, it } from "vitest";
import {
  buildScheduleAgentDirectoryState,
  buildScheduleAgentOptions,
  type ScheduleAgentDirectoryInput,
  type ScheduleFormAgent,
} from "./schedule-agent-options";

function agent(overrides: Partial<ScheduleFormAgent> = {}): ScheduleFormAgent {
  return {
    id: "agent-1",
    serverId: "host-1",
    title: "Nightly triage",
    cwd: "/tmp/project",
    archived: false,
    ...overrides,
  };
}

function directory(
  overrides: Partial<ScheduleAgentDirectoryInput> = {},
): ScheduleAgentDirectoryInput {
  return {
    serverId: "host-1",
    agents: [agent()],
    connectionStatus: "online",
    directoryStatus: "ready",
    hasEverLoadedAgentDirectory: true,
    ...overrides,
  };
}

describe("buildScheduleAgentOptions", () => {
  it("drops archived agents so a doomed target is never offered", () => {
    const options = buildScheduleAgentOptions([
      agent({ id: "live" }),
      agent({ id: "gone", archived: true }),
    ]);

    expect(options.map((option) => option.value)).toEqual(["live"]);
  });

  it("preserves the directory order it was given", () => {
    const options = buildScheduleAgentOptions([
      agent({ id: "running" }),
      agent({ id: "recent" }),
      agent({ id: "older" }),
    ]);

    expect(options.map((option) => option.value)).toEqual(["running", "recent", "older"]);
  });

  it("shortens the working directory it shows under each agent", () => {
    const [option] = buildScheduleAgentOptions([
      agent({ cwd: "/Users/someone/Documents/Projects/paseo" }),
    ]);

    expect(option?.description).not.toContain("/Users/someone");
    expect(option?.description).toContain("paseo");
  });

  it("labels untitled agents the way the schedules list does", () => {
    const options = buildScheduleAgentOptions([
      agent({ id: "blank", title: "   " }),
      agent({ id: "null-title", title: null }),
    ]);

    expect(options.map((option) => option.label)).toEqual(["Untitled agent", "Untitled agent"]);
    expect(options[0]?.testID).toBe("schedule-agent-option-blank");
  });
});

describe("buildScheduleAgentDirectoryState", () => {
  it("is connecting when the host has no runtime snapshot yet", () => {
    expect(
      buildScheduleAgentDirectoryState(
        directory({ connectionStatus: null, directoryStatus: null }),
      ),
    ).toEqual({ status: "connecting" });
  });

  it("is connecting for a host that is still coming online", () => {
    expect(
      buildScheduleAgentDirectoryState(
        directory({
          connectionStatus: "connecting",
          directoryStatus: "idle",
          hasEverLoadedAgentDirectory: false,
        }),
      ),
    ).toEqual({ status: "connecting" });
  });

  it("is loading on the first fetch", () => {
    expect(
      buildScheduleAgentDirectoryState(
        directory({ directoryStatus: "initial_loading", hasEverLoadedAgentDirectory: false }),
      ),
    ).toEqual({ status: "loading" });
  });

  it("keeps serving the last data while revalidating", () => {
    const state = buildScheduleAgentDirectoryState(directory({ directoryStatus: "revalidating" }));

    expect(state).toEqual({ status: "loaded", data: [agent()] });
  });

  it("never claims an empty directory from a failed first fetch", () => {
    expect(
      buildScheduleAgentDirectoryState(
        directory({
          agents: [],
          directoryStatus: "error_before_first_success",
          hasEverLoadedAgentDirectory: false,
        }),
      ),
    ).toEqual({ status: "connecting" });
  });

  it("reports a genuinely empty host once it has answered", () => {
    expect(buildScheduleAgentDirectoryState(directory({ agents: [] }))).toEqual({
      status: "loaded",
      data: [],
    });
  });

  it("scopes agents to the requested host", () => {
    const state = buildScheduleAgentDirectoryState(
      directory({
        agents: [agent({ id: "mine" }), agent({ id: "theirs", serverId: "host-2" })],
      }),
    );

    expect(state).toEqual({ status: "loaded", data: [agent({ id: "mine" })] });
  });
});
