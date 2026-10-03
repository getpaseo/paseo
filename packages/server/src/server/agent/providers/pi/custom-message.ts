import type { PiAgentMessage } from "./rpc-types.js";

type PiCustomMessage = Extract<PiAgentMessage, { role: "custom" }>;

// pi-fork providers (omo/senpi) mark harness-injected custom messages with
// `display: false` when the harness renders them itself. The pi adapter has no
// renderer hook to run, so honouring the flag is what keeps those blocks out of
// the timeline. Mirrors shouldDisplayOmpCustomMessage in the omp provider.
export function shouldDisplayPiCustomMessage(message: PiCustomMessage): boolean {
  return Reflect.get(message, "display") !== false;
}
