import { setImmediate as nextTurn } from "node:timers/promises";
import { measureMainThreadWork } from "../../../test-utils/main-thread-work.js";
import { AgentTimeline } from "../timeline/index.js";

// Measure a cold fetch on its own thread, without Vitest reporting or callbacks.
const wholeTurns = process.argv[2] === "true";
const timeline = new AgentTimeline();
const scope = { agentId: "large" };
await timeline.create(scope);
await timeline.append(
  scope,
  Array.from({ length: 100_000 }, (_, index) => ({
    item: { type: "user_message" as const, text: String(index) },
  })),
);
// Finish fixture allocation and collect its temporary garbage before measuring.
globalThis.gc!();
await nextTurn();
const measured = await measureMainThreadWork(
  `timeline tail main-thread work (wholeTurns=${wholeTurns})`,
  async () => {
    let page = await timeline.fetch(scope, { limit: 200, wholeTurns });
    for (let repeat = 1; repeat < 8; repeat++)
      page = await timeline.fetch(scope, { limit: 200, wholeTurns });
    return page;
  },
);

process.stdout.write(JSON.stringify(measured));
