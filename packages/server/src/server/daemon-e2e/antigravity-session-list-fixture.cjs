// An ACP peer that returns sessions in storage order, with an optional page boundary.
const readline = require("node:readline");

if (process.argv.includes("--version")) {
  process.stdout.write("1.5.13\n");
  process.exit(0);
}

const sessions = Array.from({ length: 317 }, (_, index) => ({
  sessionId: `session-${index}`,
  cwd: process.cwd(),
  title: `September session ${index}`,
  updatedAt: "2026-09-08T11:36:19Z",
}));
sessions[42] = {
  ...sessions[42],
  title: "Latest November session",
  updatedAt: "2026-11-23T04:07:46Z",
};

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  let response;
  if (method === "initialize") {
    response = {
      result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } } },
    };
  } else if (method === "session/list") {
    const pageSize = process.argv.includes("--paginated") ? 42 : sessions.length;
    response = {
      result: params.cursor
        ? { sessions: sessions.slice(pageSize) }
        : {
            sessions: sessions.slice(0, pageSize),
            nextCursor: pageSize < sessions.length ? "next" : null,
          },
    };
  } else {
    response = { error: { code: -32601, message: `Unsupported method ${method}` } };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...response }) + "\n");
});
