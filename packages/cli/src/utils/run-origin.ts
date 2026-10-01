import { readFileSync } from "node:fs";
import { basename } from "node:path";

interface OriginSources {
  env: NodeJS.ProcessEnv;
  isTty: boolean;
  ppid: number;
  readFile: (path: string) => string;
}

function read(sources: OriginSources, path: string): string {
  try {
    return sources.readFile(path);
  } catch {
    return "";
  }
}

/**
 * Who invoked `pandaos run`, for the `paseo.origin` label: a systemd unit, a terminal, or the parent
 * script. Undefined inside an agent, where the daemon records the calling agent instead.
 */
export function detectRunOrigin(sources: OriginSources = defaultSources()): string | undefined {
  if (sources.env.PASEO_AGENT_ID) return undefined;
  // Linux only: the innermost cgroup names the systemd unit a timer or service ran us in.
  const unit = read(sources, "/proc/self/cgroup")
    .split("\n")
    .map((line) => line.split("/").pop() ?? "")
    .find((segment) => segment.endsWith(".service") && !segment.startsWith("user@"));
  if (unit) return `systemd:${unit}`;
  if (sources.isTty) return "user:cli";
  const parent = read(sources, `/proc/${sources.ppid}/cmdline`).split("\0").filter(Boolean);
  const script = parent.find((arg, index) => index > 0 && !arg.startsWith("-")) ?? parent[0];
  return script ? `process:${basename(script)}` : undefined;
}

function defaultSources(): OriginSources {
  return {
    env: process.env,
    isTty: Boolean(process.stdin.isTTY),
    ppid: process.ppid,
    readFile: (path) => readFileSync(path, "utf8"),
  };
}

/** Adds `paseo.origin` from the invoking process unless the caller passed one with --label. */
export function withRunOrigin(labels: Record<string, string>): Record<string, string> {
  if (labels["paseo.origin"]) return labels;
  const origin = detectRunOrigin();
  return origin ? { ...labels, "paseo.origin": origin } : labels;
}
