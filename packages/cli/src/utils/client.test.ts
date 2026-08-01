import { expect, test } from "vitest";
import type { DaemonTransport } from "@getpaseo/client/internal/daemon-client";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { createCliDaemonClient } from "./client";

test("CLI clients explicitly opt out of provider child streams", async () => {
  const sent: string[] = [];
  let open: () => void = () => {};
  let message: (data: unknown) => void = () => {};
  const transport: DaemonTransport = {
    send(data) {
      if (typeof data === "string") sent.push(data);
    },
    close() {},
    onOpen(handler) {
      open = handler;
      return () => {};
    },
    onMessage(handler) {
      message = handler;
      return () => {};
    },
    onClose() {
      return () => {};
    },
    onError() {
      return () => {};
    },
  };
  const client = createCliDaemonClient({
    url: "ws://test",
    clientId: "cli-capability-test",
    transportFactory: () => transport,
    reconnect: { enabled: false },
  });

  const connecting = client.connect();
  open();
  message(
    JSON.stringify({
      type: "session",
      message: {
        type: "status",
        payload: { status: "server_info", serverId: "test", hostname: null, version: null },
      },
    }),
  );
  await connecting;

  const hello = JSON.parse(sent[0]) as { capabilities: Record<string, unknown> };
  expect(hello.capabilities[CLIENT_CAPS.providerSubagents]).toBe(false);
  await client.close();
});
