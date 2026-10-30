import type { DaemonClientTrace } from "@getpaseo/client/internal/daemon-client";

type Fields = Record<string, string>;
interface RenderSample {
  id: string;
  phase: string;
  actualDuration: number;
  startTime: number;
  commitTime: number;
}

/** Bounded render aggregation and scoped trace identity; no payloads enter this boundary. */
export function createRecorder(write: (name: string, fields: Fields) => void, now: () => number) {
  let nextClient = 0;
  const renders = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  const record = (name: string, fields: Fields = {}) =>
    write(name, { ...fields, jsMonoMs: String(now()) });
  return {
    record,
    trace(context: Fields): DaemonClientTrace {
      const client = String(++nextClient);
      let sequence = 0;
      const sections: { id: string; name: string; start: number }[] = [];
      return {
        isEnabled: () => true,
        beginSection(name, fields) {
          const id = `${client}:${++sequence}`;
          record(`${name}.begin`, {
            ...context,
            ...fields,
            client,
            span: id,
            parent: sections.at(-1)?.id ?? "",
          });
          sections.push({ id, name, start: now() });
        },
        endSection() {
          const section = sections.pop();
          if (section)
            record(`${section.name}.end`, {
              ...context,
              client,
              span: section.id,
              durationMs: String(now() - section.start),
            });
        },
      };
    },
    render(sample: RenderSample) {
      if (sample.actualDuration >= 16) {
        record("react.render.slow", {
          region: sample.id,
          phase: sample.phase,
          renderMs: String(sample.actualDuration),
          startMs: String(sample.startTime),
          commitMs: String(sample.commitTime),
        });
      }
      // Dynamic agent/tab IDs cannot grow this map without bound.
      const key = renders.has(sample.id) || renders.size < 128 ? sample.id : "other";
      const summary = renders.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
      summary.count++;
      summary.totalMs += sample.actualDuration;
      summary.maxMs = Math.max(summary.maxMs, sample.actualDuration);
      renders.set(key, summary);
    },
    flushRenders() {
      for (const [region, summary] of renders) {
        record("react.render.summary", {
          region,
          count: String(summary.count),
          totalMs: String(summary.totalMs),
          maxMs: String(summary.maxMs),
        });
      }
      renders.clear();
    },
  };
}
