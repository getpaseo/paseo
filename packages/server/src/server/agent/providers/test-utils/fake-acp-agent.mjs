// A stdio ACP agent for tests. argv[2] is a JSON scenario:
//   options: the session's config options
//   answers: { [configId]: value } the agent ends up with instead of the requested value
//   onWrite: "notify-first" sends config_option_update before answering the write;
//            "notify-then-reject" does the same and then fails the write
//   moves:   { [configId]: { [id]: value } } writes that also move another select, announced
//            by a config_option_update after the write is answered
//   adds:    { [configId]: option[] } writes that make more selects appear, announced the same way
//   models:  the model state session/new returns
//   modelLevels: { [model]: level[] } the thought_level choices of each value of the model
//            select. A model switch keeps the current level when the new model offers it.
//            session/set_model takes a "<model>-<level>" id and moves both selects. Every
//            write is announced by a config_option_update after it is answered.
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

const scenario = JSON.parse(process.argv[2] ?? "{}");
let options = scenario.options ?? [];

function set(id, value) {
  options = options.map((option) =>
    option.id === id ? { ...option, currentValue: value } : option,
  );
}

function applyModel(model, requestedLevel) {
  const levels = scenario.modelLevels[model] ?? [];
  const current = options.find((option) => option.category === "thought_level")?.currentValue;
  const level = [requestedLevel, current].find((value) => levels.includes(value)) ?? levels[0];
  options = options.map((option) => {
    if (option.category === "model") return { ...option, currentValue: model };
    if (option.category !== "thought_level") return option;
    return {
      ...option,
      currentValue: level,
      options: levels.map((value) => ({ value, name: value })),
    };
  });
}

function splitModelId(modelId) {
  const model = Object.keys(scenario.modelLevels)
    .filter((value) => modelId === value || modelId.startsWith(`${value}-`))
    .sort((a, b) => b.length - a.length)[0];
  return model ? [model, modelId.slice(model.length + 1)] : [modelId, undefined];
}

function announceTo(agentConnection, sessionId) {
  return agentConnection.sessionUpdate({
    sessionId,
    update: { sessionUpdate: "config_option_update", configOptions: options },
  });
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
export const connection = new AgentSideConnection(
  (agentConnection) => ({
    async initialize() {
      return { protocolVersion: 1, agentCapabilities: {} };
    },
    async newSession() {
      return {
        sessionId: "session-1",
        modes: null,
        models: scenario.models ?? null,
        configOptions: options,
      };
    },
    async unstable_setSessionModel({ sessionId, modelId }) {
      applyModel(...splitModelId(modelId));
      setTimeout(() => void announceTo(agentConnection, sessionId), 20);
      return {};
    },
    async setSessionConfigOption({ sessionId, configId, value }) {
      const announce = () => announceTo(agentConnection, sessionId);
      const isModel = options.find((option) => option.id === configId)?.category === "model";
      if (scenario.modelLevels && isModel) {
        applyModel(value);
      } else {
        set(configId, scenario.answers?.[configId] ?? value);
      }
      if (scenario.modelLevels) {
        setTimeout(() => void announce(), 20);
        return { configOptions: options };
      }
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
