const { randomUUID } = require("node:crypto");
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");

const eventsPath = process.argv[2];
const record = (event) => appendFileSync(eventsPath, JSON.stringify(event) + "\n");
const modes = {
  currentModeId: "default",
  availableModes: [{ id: "default", name: "Default" }],
};

process.on("SIGINT", () => {
  record({ type: "sigint", pid: process.pid });
  process.exit(0);
});

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;

  let result;
  switch (message.method) {
    case "initialize":
      result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      break;
    case "session/new": {
      const sessionId = randomUUID();
      record({ type: "session", pid: process.pid, sessionId });
      result = { sessionId, modes };
      break;
    }
    case "session/load":
      result = { modes };
      break;
    case "session/close":
      // Keep the provider alive long enough to detect a signal sent down the dev watcher tree.
      setTimeout(() => reply(message.id, {}), 400);
      return;
    case "session/prompt": {
      const { sessionId, prompt } = message.params;
      const text = prompt
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      record({ type: "prompt", sessionId, text });
      if (text === "Hold the turn open.") return;
      result = { stopReason: "end_turn" };
      break;
    }
    default:
      result = {};
  }
  reply(message.id, result);
});

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
