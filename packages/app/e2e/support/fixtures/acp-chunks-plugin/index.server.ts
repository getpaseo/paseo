import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider, type AcpStreamMessage } from "@getpaseo/plugin/server/acp";

function connect() {
  let controller: ReadableStreamDefaultController<AcpStreamMessage>;
  return {
    readable: new ReadableStream<AcpStreamMessage>({
      start(value) {
        controller = value;
      },
    }),
    writable: new WritableStream<AcpStreamMessage>({
      write(message) {
        if (!("method" in message) || !("id" in message)) return;
        let result: unknown = {};
        if (message.method === "initialize") result = { protocolVersion: 1, agentCapabilities: {} };
        if (message.method === "session/new") result = { sessionId: "chunks" };
        if (message.method === "session/prompt") {
          for (const text of [
            "- **Current tem",
            "perature**: 25°C. Read [Paseo ",
            "docs](https://example.com/docs).",
          ]) {
            controller.enqueue({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "chunks",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
              },
            });
          }
          result = { stopReason: "end_turn" };
        }
        controller.enqueue({ jsonrpc: "2.0", id: message.id, result });
      },
    }),
  };
}

export default function contribute(server: PluginServerContext) {
  server.registerProvider(
    runAcpProvider({ id: "acp-chunks", label: "ACP chunks", connector: connect }),
  );
  return () => {};
}
