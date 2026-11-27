// Local ACP peer that echoes each prompt and advertises loadSession, but answers
// every session/load with an error, like a provider that did not save the session.
const readline = require("node:readline");

const agentCapabilities = { loadSession: true };
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  switch (method) {
    case "initialize":
      send({
        id,
        result: { protocolVersion: 1, agentCapabilities, authMethods: [] },
      });
      return;
    case "session/new":
      send({ id, result: { sessionId: "acp-echo-session" } });
      return;
    case "session/prompt": {
      const text = params.prompt.map((block) => block.text ?? "").join("");
      send({
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `echo: ${text}` },
          },
        },
      });
      send({ id, result: { stopReason: "end_turn" } });
      return;
    }
    case "session/load":
      send({ id, error: { code: -32603, message: "session not saved" } });
      return;
    default:
      send({ id, result: {} });
  }
});
