#!/usr/bin/env node
// Summarizes System One shadow mode: how often Jev predicted each agent's next step,
// and how much time prefetching could have saved. Usage: node scripts/shadow-stats.mjs [file]
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const file =
  process.argv[2] ??
  path.join(
    process.env.PANDAOS_HOME ??
      process.env.PASEO_HOME ??
      (existsSync(path.join(os.homedir(), ".pandaos"))
        ? path.join(os.homedir(), ".pandaos")
        : path.join(os.homedir(), ".paseo")),
    "system-one",
    "shadow.jsonl",
  );
// Side-effect free steps are the only ones a prefetch may run; verify can only be prepared.
const SAFE = new Set(["read", "search", "fetch"]);

const records = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

function summarize(rows) {
  const hits = rows.filter((row) => row.hit);
  const confident = rows.filter((row) => row.confidence >= 0.8);
  const inTime = hits.filter((row) => row.leadMs > 0 && row.stepMs !== null);
  const saved = (filter) =>
    inTime.filter(filter).reduce((sum, row) => sum + Math.min(row.stepMs, row.leadMs), 0) / 1000;
  const pct = (part, whole) => (whole === 0 ? "-" : `${Math.round((part / whole) * 100)}%`);
  const thinkMs = rows.map((row) => row.thinkMs).filter((value) => typeof value === "number");
  const toolMs = rows.map((row) => row.stepMs).filter((value) => typeof value === "number");
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  // Upper bound: Jev predicts the kind of step, not its arguments.
  const predictable = rows.filter((row) => row.hit && row.confidence >= 0.9);
  return {
    steps: rows.length,
    hitRate: pct(hits.length, rows.length),
    top2Rate: pct(rows.filter((row) => row.top2Hit).length, rows.length),
    medianThinkMs: median(thinkMs),
    llmShareOfTime: pct(sum(thinkMs), sum(thinkMs) + sum(toolMs)),
    predictableDecisionsMax: pct(predictable.length, rows.length),
    hitRateConfident: pct(confident.filter((row) => row.hit).length, confident.length),
    readyInTime: pct(inTime.length, hits.length),
    medianJevMs: median(rows.map((row) => row.jevMs)),
    prefetchableSavedS: saved((row) => SAFE.has(row.actual)).toFixed(1),
    preparableSavedS: saved((row) => row.actual === "verify").toFixed(1),
  };
}

function median(values) {
  if (values.length === 0) return "-";
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const byProvider = Object.groupBy(records, (row) => row.provider);
console.table({
  all: summarize(records),
  ...Object.fromEntries(Object.entries(byProvider).map(([p, rows]) => [p, summarize(rows)])),
});
console.table(
  Object.fromEntries(
    Object.entries(Object.groupBy(records, (row) => row.actual)).map(([step, rows]) => [
      step,
      summarize(rows),
    ]),
  ),
);
