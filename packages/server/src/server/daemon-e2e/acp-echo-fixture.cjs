// Local ACP peer that echoes each prompt. It appends its pid to the file named by
// its first argument, so a test can find and kill the running process. A second
// argument of "no-load" makes it advertise no way to reopen a session.
const fs = require("node:fs");
const readline = require("node:readline");

fs.appendFileSync(process.argv[2], `${process.pid}\n`);
const agentCapabilities = process.argv[3] === "no-load" ? {} : { loadSession: true };
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
    default:
      send({ id, result: {} });
  }
});
