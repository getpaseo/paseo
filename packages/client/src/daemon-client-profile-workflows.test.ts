import { expect, test } from "vitest";
import { DaemonClient, type DaemonTransport } from "./daemon-client.js";

test.each([false, true])(
  "profile workflow additions require the host capability: %s",
  async (supported) => {
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
      clientId: "profile-workflow",
      transportFactory: () => transport,
      reconnect: { enabled: false },
    });
    try {
      const connection = client.connect();
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
              ...(supported ? { features: { agentProfileWorkflows: true } } : {}),
            },
          },
        }),
      );
      await connection;
      sent.length = 0;
      const pending = client.patchDaemonConfig({ addAgentProfilesIfMissing: [] });
      void pending.catch(() => {});
      if (!supported) {
        expect(sent).toEqual([]);
        await expect(pending).rejects.toThrow("Update the host");
      } else {
        expect(sent).toHaveLength(1);
        const request = JSON.parse(sent[0]).message;
        receive(
          JSON.stringify({
            type: "session",
            message: {
              type: "rpc_error",
              requestId: request.requestId,
              requestType: request.type,
              code: "handler_error",
              error: "fixture",
            },
          }),
        );
        await client.close();
        await expect(pending).rejects.toThrow();
      }
    } finally {
      await client.close();
    }
  },
);
