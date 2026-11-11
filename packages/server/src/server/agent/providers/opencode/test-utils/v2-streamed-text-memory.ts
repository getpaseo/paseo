import { TimelineProjection } from "../../../timeline-projection.js";
import { V2Timeline } from "../v2/timeline.js";

// Streams one reasoning part through the timeline into the daemon's projection and
// prints the bytes still held once the part is complete.
const mode = process.argv[2];
const chunks = Number(process.argv[3]);
if (mode !== "delta" && mode !== "snapshot") throw new Error("Mode must be delta or snapshot");
if (!global.gc) throw new Error("Run with --expose-gc");

global.gc();
const before = process.memoryUsage().heapUsed;
const timeline = new V2Timeline();
const projection = new TimelineProjection();
const part = { assistantMessageID: "answer", type: "reasoning" as const, ordinal: 0 };
timeline.startPart(part);
let text = "";
for (let index = 0; index < chunks; index++) {
  const delta = `chunk-${index}:`.padEnd(64, String.fromCharCode(65 + (index % 26)));
  text += delta;
  const event =
    mode === "delta"
      ? timeline.delta({ ...part, delta })
      : timeline.messages([
          {
            id: "answer",
            type: "assistant",
            agent: "build",
            model: { providerID: "test", id: "model" },
            time: { created: 2 },
            content: [{ type: "reasoning", text }],
          },
        ])[0];
  if (event?.type !== "timeline") throw new Error("Expected a timeline event");
  projection.append({
    seq: index + 1,
    timestamp: "2026-10-01T00:00:00.000Z",
    turnId: "turn",
    item: event.item,
  });
}
global.gc();
const retainedBytes = process.memoryUsage().heapUsed - before;
const [row] = projection.getRows();
if (row?.item.type !== "reasoning" || row.item.text !== text) {
  throw new Error("Projection lost the streamed text");
}
process.stdout.write(String(retainedBytes));
