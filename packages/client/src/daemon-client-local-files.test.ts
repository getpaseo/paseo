import { expect, test } from "vitest";
import { DaemonClient } from "./daemon-client.js";

test.each([
  "ws://remote.example/ws",
  "ws://192.0.2.1/ws",
  "wss://relay.example/ws?role=client&serverId=fixture",
])("blocks sensitive file contents over an unprotected connection: %s", async (url) => {
  const client = new DaemonClient({ url, clientId: "local-files-transport-test" });
  await expect(
    client.readProjectLocalFile({
      projectId: "fixture",
      path: ".env",
      expectedRevision: "revision",
    }),
  ).rejects.toThrow("secure_connection_required");
  await expect(
    client.importProjectLocalFile({
      projectId: "fixture",
      path: ".env",
      expectedRevision: null,
      data: "",
    }),
  ).rejects.toThrow("secure_connection_required");
});
