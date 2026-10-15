import { expect, test } from "vitest";
import { DaemonClient, type DaemonTransport } from "./daemon-client.js";

test.each([
  { feature: false, writePolicy: "read_only" as const, blocked: true, resume: false },
  { feature: true, writePolicy: "read_only" as const, blocked: false, resume: false },
  { feature: false, writePolicy: "read_write" as const, blocked: false, resume: false },
  { feature: false, writePolicy: "read_only" as const, blocked: true, resume: true },
])(
  "write policy $writePolicy with capability $feature, resume $resume rejects before send: $blocked",
  async ({ feature, writePolicy, blocked, resume }) => {
    let open = () => {};
    let receive = (_data: string) => {};
    const sent: string[] = [];
    const transport: DaemonTransport = {
      send: (data) => {
        if (typeof data === "string") sent.push(data);
      },
      close: () => {},
      onOpen: (handler) => {
        open = handler;
        return () => {};
      },
      onMessage: (handler) => {
        receive = (data) => handler(data, false);
        return () => {};
      },
      onClose: () => () => {},
      onError: () => () => {},
    };
    const client = new DaemonClient({
      url: "ws://fixture",
      clientId: "write-policy-fixture",
      transportFactory: () => transport,
      reconnect: { enabled: false },
    });
    try {
      const connected = client.connect();
      open();
      receive(
        JSON.stringify({
          type: "session",
          message: {
            type: "status",
            payload: {
              status: "server_info",
              serverId: "fixture",
              hostname: null,
              version: null,
              ...(feature ? { features: { agentWritePolicy: true } } : {}),
            },
          },
        }),
      );
      await connected;
      sent.length = 0;
      const pending = resume
        ? client.resumeAgent({ provider: "codex", sessionId: "fixture", metadata: { writePolicy } })
        : client.createAgent({ provider: "codex", cwd: "/workspace", writePolicy });
      void pending.catch(() => {});
      if (blocked) {
        expect(sent).toEqual([]);
        await expect(pending).rejects.toThrow("Update the host");
      } else {
        expect(sent).toHaveLength(1);
        const request = JSON.parse(sent[0]!).message;
        expect(request.config.writePolicy).toBe(writePolicy);
        receive(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "agent_create_failed",
                requestId: request.requestId,
                error: "fixture response",
              },
            },
          }),
        );
        await expect(pending).rejects.toThrow("fixture response");
      }
    } finally {
      await client.close();
    }
  },
);
