import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectToDaemon } from "../../utils/client.js";
import { createAgentCommand } from "./index.js";

vi.mock("../../utils/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/client.js")>()),
  connectToDaemon: vi.fn(),
}));

const staleId = "11111111-1111-4111-8111-111111111111";
const reopenedId = "22222222-2222-4222-8222-222222222222";
const backgroundId = "33333333-3333-4333-8333-333333333333";

function createClient() {
  return {
    close: vi.fn(async () => undefined),
    getLastServerInfoMessage: vi.fn<() => { features?: { archiveStaleClosedAgent?: boolean } }>(
      () => ({
        features: { archiveStaleClosedAgent: true },
      }),
    ),
    listStaleClosedAgentIds: vi.fn(async () => [staleId, reopenedId, backgroundId]),
    archiveStaleClosedAgent: vi.fn(async (id: string) => id !== reopenedId),
    archiveAgent: vi.fn(),
  };
}

function runSweep() {
  return createAgentCommand().parseAsync(["sweep-closed", "--home", "/tmp/paseo-sweep"], {
    from: "user",
  });
}

describe("agent sweep-closed", () => {
  let client: ReturnType<typeof createClient>;
  const connect = vi.mocked(connectToDaemon);

  beforeEach(() => {
    client = createClient();
    connect.mockReset().mockResolvedValue(client as unknown as Awaited<ReturnType<typeof connect>>);
  });

  it("uses the guarded operation for each candidate ID from the daemon", async () => {
    await runSweep();

    expect(connect).toHaveBeenCalledWith({
      target: { kind: "instance", home: "/tmp/paseo-sweep" },
    });
    expect(client.listStaleClosedAgentIds).toHaveBeenCalledOnce();
    // A candidate can reopen before the guarded request. The next ID still gets checked.
    expect(client.archiveStaleClosedAgent.mock.calls).toEqual([
      [staleId],
      [reopenedId],
      [backgroundId],
    ]);
    expect(client.archiveAgent).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("leaves an older daemon alone", async () => {
    client.getLastServerInfoMessage.mockReturnValue({});

    await runSweep();

    expect(client.listStaleClosedAgentIds).not.toHaveBeenCalled();
    expect(client.archiveStaleClosedAgent).not.toHaveBeenCalled();
    expect(client.archiveAgent).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it.each(["DAEMON_NOT_RUNNING", "ECONNREFUSED"])(
    "finishes quietly if the daemon is unavailable (%s)",
    async (code) => {
      connect.mockRejectedValueOnce({ code });
      await expect(runSweep()).resolves.toBeDefined();
    },
  );

  it("finishes quietly on a lost connection without retrying the current operation", async () => {
    client.archiveStaleClosedAgent.mockRejectedValueOnce({ code: "DAEMON_CONNECTION_LOST" });

    await expect(runSweep()).resolves.toBeDefined();

    expect(client.archiveStaleClosedAgent.mock.calls).toEqual([[staleId]]);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("reports an archive error from a reachable daemon", async () => {
    const error = { code: "agent_archive_failed", message: "Archive failed" };
    client.archiveStaleClosedAgent.mockRejectedValueOnce(error);

    await expect(runSweep()).rejects.toEqual(error);

    expect(client.close).toHaveBeenCalledOnce();
  });
});
