import { expect, test } from "vitest";
import { createRecorder } from "./recorder";

function fixture() {
  const events: { name: string; fields: Record<string, string> }[] = [];
  let now = 0;
  const recorder = createRecorder(
    (name, fields) => events.push({ name, fields }),
    () => now,
  );
  return {
    recorder,
    events,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("interleaved hosts keep independent parent spans and durations", () => {
  const { recorder, events, advance } = fixture();
  const a = recorder.trace({ host: "a" });
  const b = recorder.trace({ host: "b" });
  a.beginSection("frame");
  advance(5);
  b.beginSection("frame");
  a.beginSection("parse");
  advance(15);
  a.endSection();
  b.endSection();
  a.endSection();
  expect(
    events.map(({ name, fields }) => [
      name,
      fields.host,
      fields.span,
      fields.parent,
      fields.durationMs,
    ]),
  ).toEqual([
    ["frame.begin", "a", "1:1", "", undefined],
    ["frame.begin", "b", "2:1", "", undefined],
    ["parse.begin", "a", "1:2", "1:1", undefined],
    ["parse.end", "a", "1:2", undefined, "15"],
    ["frame.end", "b", "2:1", undefined, "15"],
    ["frame.end", "a", "1:1", undefined, "20"],
  ]);
});

test("slow renders preserve commit identity while fast renders are summarized", () => {
  const { recorder, events } = fixture();
  for (const actualDuration of [1, 2, 30])
    recorder.render({
      id: "Stream",
      phase: "update",
      actualDuration,
      startTime: 4,
      commitTime: 40,
    });
  recorder.flushRenders();
  recorder.flushRenders();
  expect(events).toEqual([
    {
      name: "react.render.slow",
      fields: {
        region: "Stream",
        phase: "update",
        renderMs: "30",
        startMs: "4",
        commitMs: "40",
        jsMonoMs: "0",
      },
    },
    {
      name: "react.render.summary",
      fields: { region: "Stream", count: "3", totalMs: "33", maxMs: "30", jsMonoMs: "0" },
    },
  ]);
});

test("dynamic regions are bounded and summaries reset each interval", () => {
  const { recorder, events } = fixture();
  for (let i = 0; i < 10000; i++)
    recorder.render({
      id: String(i),
      phase: "mount",
      actualDuration: 1,
      startTime: 0,
      commitTime: 1,
    });
  recorder.flushRenders();
  expect(events.length).toBe(129);
  expect(events.at(-1)?.fields).toEqual({
    region: "other",
    count: "9872",
    totalMs: "9872",
    maxMs: "1",
    jsMonoMs: "0",
  });
  recorder.render({ id: "new", phase: "mount", actualDuration: 1, startTime: 0, commitTime: 1 });
  recorder.flushRenders();
  expect(events.at(-1)?.fields.region).toBe("new");
});
