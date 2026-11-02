import { setImmediate as nextTurn } from "node:timers/promises";
import { measureMainThreadWork } from "../../../test-utils/main-thread-work.js";
import { InMemoryAgentTimelineStore } from "../agent-timeline-store.js";

// Measure a cold fetch on its own thread, without Vitest reporting or callbacks.
const wholeTurns = process.argv[2] === "true";
const store = new InMemoryAgentTimelineStore();
store.initialize("large");
for (let index = 0; index < 100_000; index++) {
  store.append("large", { type: "user_message", text: String(index) });
}
// Finish fixture allocation and collect its temporary garbage before measuring.
globalThis.gc!();
await nextTurn();
const measured = await measureMainThreadWork(
  `timeline tail main-thread work (wholeTurns=${wholeTurns})`,
  () => {
    let page = store.fetch("large", { limit: 200, wholeTurns });
    for (let repeat = 1; repeat < 8; repeat++)
      page = store.fetch("large", { limit: 200, wholeTurns });
    return page;
  },
);

process.stdout.write(JSON.stringify(measured));
