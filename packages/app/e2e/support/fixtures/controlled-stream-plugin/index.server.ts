import { defineRpc } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider, type AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { z } from "zod";

/** A single-turn producer controlled through the daemon, before timeline persistence. */
export default function contribute(server: PluginServerContext) {
  let startTurn!: (append: (chunks: string[], finish: boolean) => void) => void;
  const turn = new Promise<(chunks: string[], finish: boolean) => void>((resolve) => {
    startTurn = resolve;
  });
  server.handle(
    defineRpc({
      name: "append",
      input: z.object({ chunks: z.array(z.string()), finish: z.boolean() }),
      output: z.null(),
    }),
    async ({ chunks, finish }) => {
      const append = await turn;
      append(chunks, finish);
      return null;
    },
  );
  server.registerProvider(
    runAcpProvider({ id: "controlled-stream", label: "Controlled stream", connector: connect }),
  );
  return () => {};

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
          if (message.method === "session/prompt") {
            let finished = false;
            startTurn((chunks, finish) => {
              if (finished) return;
              for (const text of chunks) {
                controller.enqueue({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: "controlled",
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text },
                    },
                  },
                });
              }
              if (finish) {
                finished = true;
                controller.enqueue({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: { stopReason: "end_turn" },
                });
              }
            });
            return;
          }
          let result: unknown = {};
          if (message.method === "initialize") {
            result = { protocolVersion: 1, agentCapabilities: {} };
          } else if (message.method === "session/new") {
            result = { sessionId: "controlled" };
          }
          controller.enqueue({ jsonrpc: "2.0", id: message.id, result });
        },
      }),
    };
  }
}
