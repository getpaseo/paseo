import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { SessionDataOwner } from ".";

const SERVER_ID = "queued-drainer";

class FakeClient {
  sent: Array<Parameters<DaemonClient["sendAgentMessage"]>> = [];
  responses: Promise<void>[] = [];
  failures: Error[] = [];

  async sendAgentMessage(
    ...args: Parameters<DaemonClient["sendAgentMessage"]>
  ): ReturnType<DaemonClient["sendAgentMessage"]> {
    this.sent.push(args);
    const response = this.responses.shift();
    if (response) await response;
    const failure = this.failures.shift();
    if (failure) throw failure;
  }
}

function initialize(client: FakeClient): void {
  useSessionStore.getState().initializeSession(SERVER_ID, client as unknown as DaemonClient, 1);
}

afterEach(() => useSessionStore.getState().clearSession(SERVER_ID));

describe("SessionDataOwner queued-message draining", () => {
  it("does not send without a queue", async () => {
    const client = new FakeClient();
    initialize(client);
    const owner = new SessionDataOwner();
    owner.drainQueuedAgentMessage(SERVER_ID, "agent");
    await Promise.resolve();
    expect(client.sent).toEqual([]);
  });

  it("does not send while the agent is initializing", async () => {
    const client = new FakeClient();
    initialize(client);
    const owner = new SessionDataOwner();
    useSessionStore
      .getState()
      .setQueuedMessages(
        SERVER_ID,
        new Map([["agent", [{ id: "queued", text: "later", attachments: [] }]]]),
      );
    useSessionStore.getState().setInitializingAgents(SERVER_ID, new Map([["agent", true]]));
    owner.drainQueuedAgentMessage(SERVER_ID, "agent");
    await Promise.resolve();
    expect(client.sent).toEqual([]);
  });

  it("sends attachments through the composer submission path", async () => {
    const client = new FakeClient();
    initialize(client);
    useSessionStore.getState().setQueuedMessages(
      SERVER_ID,
      new Map([
        [
          "agent",
          [
            {
              id: "queued",
              text: "review",
              attachments: [
                {
                  kind: "workspace_file" as const,
                  path: "src/main.ts",
                  selection: { kind: "whole_file" as const },
                },
              ],
            },
          ],
        ],
      ]),
    );

    new SessionDataOwner().drainQueuedAgentMessage(SERVER_ID, "agent");
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));

    expect(client.sent[0]?.[2]?.attachments).toEqual([
      expect.objectContaining({ type: "text", title: "main.ts" }),
    ]);
  });

  it("retains the queue when sending fails", async () => {
    const client = new FakeClient();
    client.failures.push(new Error("offline"));
    initialize(client);
    const queued = [{ id: "queued", text: "retry", attachments: [] }];
    useSessionStore.getState().setQueuedMessages(SERVER_ID, new Map([["agent", queued]]));

    new SessionDataOwner().drainQueuedAgentMessage(SERVER_ID, "agent");
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    await vi.waitFor(() =>
      expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent")).toEqual(
        queued,
      ),
    );
  });

  it("serializes two requests for one agent into one in-flight drain", async () => {
    const client = new FakeClient();
    let release!: () => void;
    client.responses.push(new Promise<void>((resolve) => (release = resolve)));
    initialize(client);
    useSessionStore
      .getState()
      .setQueuedMessages(
        SERVER_ID,
        new Map([["agent", [{ id: "queued", text: "once", attachments: [] }]]]),
      );
    const owner = new SessionDataOwner();

    owner.drainQueuedAgentMessage(SERVER_ID, "agent");
    owner.drainQueuedAgentMessage(SERVER_ID, "agent");
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    release();
    await vi.waitFor(() =>
      expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent")).toEqual(
        [],
      ),
    );
  });
});
