import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const features: { callerFinishNotifications?: boolean } = {};
const createAgent = vi.fn(async () => ({
  id: "child-agent",
  status: "running",
  provider: "codex",
  cwd: "/repo",
  title: null,
}));
const sendAgentMessage = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    getLastServerInfoMessage: () => ({ features }),
    async fetchAgent({ agentId }: { agentId: string }) {
      if (agentId !== "parent-agent") throw new Error(`Agent not found: ${agentId}`);
      return { agent: { id: agentId } };
    },
    createAgent,
    sendAgentMessage,
    close: vi.fn(async () => undefined),
  })),
}));

import { addRunOptions, runRunCommand } from "./run.js";
import { addSendOptions, runSendCommand } from "./send.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

async function run(args: string[]): Promise<void> {
  const command = addRunOptions(new Command("run")).action((prompt, options, cmd) =>
    runRunCommand(prompt, { ...options, daemonTarget }, cmd),
  );
  await command.parseAsync(args, { from: "user" });
}

async function send(args: string[]): Promise<void> {
  const command = addSendOptions(new Command("send")).action((id, prompt, options, cmd) =>
    runSendCommand(id, prompt, { ...options, daemonTarget }, cmd),
  );
  await command.parseAsync(args, { from: "user" });
}

describe("--notify-on-finish", () => {
  const originalAgentId = process.env.PASEO_AGENT_ID;
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    features.callerFinishNotifications = true;
    process.env.PASEO_AGENT_ID = "parent-agent";
    delete process.env.PASEO_WORKSPACE_ID;
  });

  afterEach(() => {
    for (const [key, value] of [
      ["PASEO_AGENT_ID", originalAgentId],
      ["PASEO_WORKSPACE_ID", originalWorkspaceId],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("asks the daemon to notify the calling agent about a background run", async () => {
    await run(["--provider", "codex", "--background", "--notify-on-finish", "do the task"]);

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ callerAgentId: "parent-agent", notifyOnFinish: true }),
    );
  });

  it("does not request a notification without the flag", async () => {
    await run(["--provider", "codex", "--background", "do the task"]);

    expect(createAgent).toHaveBeenCalledWith(
      expect.not.objectContaining({ notifyOnFinish: expect.anything() }),
    );
  });

  it("asks the daemon to notify the calling agent about a sent turn", async () => {
    await send(["child-agent", "--no-wait", "--notify-on-finish", "follow up"]);

    expect(sendAgentMessage).toHaveBeenCalledWith("child-agent", "follow up", {
      images: undefined,
      callerAgentId: "parent-agent",
      notifyOnFinish: true,
    });
  });

  it("does not name a caller on a plain send", async () => {
    await send(["child-agent", "--no-wait", "follow up"]);

    expect(sendAgentMessage).toHaveBeenCalledWith("child-agent", "follow up", {
      images: undefined,
    });
  });

  it("rejects waiting commands, whose output already reaches the caller", async () => {
    await expect(
      run(["--provider", "codex", "--notify-on-finish", "do the task"]),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    await expect(send(["child-agent", "--notify-on-finish", "follow up"])).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
    expect(createAgent).not.toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it("rejects callers that are not agents on the target daemon", async () => {
    process.env.PASEO_AGENT_ID = "agent-on-another-daemon";

    await expect(
      run(["--provider", "codex", "--background", "--notify-on-finish", "do the task"]),
    ).rejects.toMatchObject({ code: "NOT_AGENT_SCOPED" });
    await expect(
      send(["child-agent", "--no-wait", "--notify-on-finish", "follow up"]),
    ).rejects.toMatchObject({ code: "NOT_AGENT_SCOPED" });
    expect(createAgent).not.toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it("asks for a host update instead of silently dropping the request", async () => {
    features.callerFinishNotifications = false;

    await expect(
      run(["--provider", "codex", "--background", "--notify-on-finish", "do the task"]),
    ).rejects.toMatchObject({ code: "DAEMON_UPDATE_REQUIRED" });
    await expect(
      send(["child-agent", "--no-wait", "--notify-on-finish", "follow up"]),
    ).rejects.toMatchObject({ code: "DAEMON_UPDATE_REQUIRED" });
    expect(createAgent).not.toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });
});
