// A stdio ACP agent for tests. argv[2] is a JSON scenario:
//   options: the session's config options
//   answers: { [configId]: value } the agent ends up with instead of the requested value
//   onWrite: "notify-first" sends config_option_update before answering the write;
//            "notify-then-reject" does the same and then fails the write
//   moves:   { [configId]: { [id]: value } } writes that also move another select, announced
//            by a config_option_update after the write is answered
//   adds:    { [configId]: option[] } writes that make more selects appear, announced the same way
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

const scenario = JSON.parse(process.argv[2] ?? "{}");
let options = scenario.options ?? [];

function set(id, value) {
  options = options.map((option) =>
    option.id === id ? { ...option, currentValue: value } : option,
  );
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
export const connection = new AgentSideConnection(
  (agentConnection) => ({
    async initialize() {
      return { protocolVersion: 1, agentCapabilities: {} };
    },
    async newSession() {
      return { sessionId: "session-1", modes: null, models: null, configOptions: options };
    },
    async setSessionConfigOption({ sessionId, configId, value }) {
      set(configId, scenario.answers?.[configId] ?? value);
      const announce = () =>
        agentConnection.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "config_option_update", configOptions: options },
        });
      if (scenario.onWrite === "notify-first" || scenario.onWrite === "notify-then-reject") {
        await announce();
        if (scenario.onWrite === "notify-then-reject") throw new Error("write refused");
        return { configOptions: options };
      }
      const moves = scenario.moves?.[configId];
      const adds = scenario.adds?.[configId];
      if (moves || adds) {
        for (const [id, moved] of Object.entries(moves ?? {})) set(id, moved);
        options = [...options, ...(adds ?? [])];
        setTimeout(() => void announce(), 20);
      }
      return { configOptions: options };
    },
    async authenticate() {
      return {};
    },
    async prompt() {
      return { stopReason: "end_turn" };
    },
    async cancel() {},
  }),
  stream,
);
