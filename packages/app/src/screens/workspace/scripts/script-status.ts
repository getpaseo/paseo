import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import type { Theme } from "@/styles/theme";

/**
 * What a script, or a set of them, is doing, as the one colour its ▶ or row icon is drawn in.
 *
 * Health is a service's own report, so it only colours running services. A plain script that is
 * running is just running.
 */
export type ScriptTone = "idle" | "running" | "healthy" | "unhealthy";

export interface ScriptsSummary {
  tone: ScriptTone;
  /** Names of the running scripts, in the order the workspace lists them. */
  running: string[];
}

export function scriptStatus(script: WorkspaceScriptPayload): ScriptTone {
  if (script.lifecycle !== "running") return "idle";
  if (script.type !== "service") return "running";
  if (script.health === "healthy") return "healthy";
  if (script.health === "unhealthy") return "unhealthy";
  return "running";
}

/**
 * One unhealthy service makes the whole set unhealthy. The set reads healthy only when every
 * running service says so; a service that has not reported yet keeps it at plain running.
 */
export function summarizeScripts(scripts: readonly WorkspaceScriptPayload[]): ScriptsSummary {
  const running = scripts.filter((script) => script.lifecycle === "running");
  if (running.length === 0) return { tone: "idle", running: [] };
  return { tone: aggregateTone(running), running: running.map((script) => script.scriptName) };
}

function aggregateTone(running: readonly WorkspaceScriptPayload[]): ScriptTone {
  const serviceTones = running
    .filter((script) => script.type === "service")
    .map((script) => scriptStatus(script));
  if (serviceTones.includes("unhealthy")) return "unhealthy";
  if (serviceTones.length > 0 && serviceTones.every((tone) => tone === "healthy")) {
    return "healthy";
  }
  return "running";
}

const idleColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const runningColorMapping = (theme: Theme) => ({ color: theme.colors.palette.blue[500] });
const healthyColorMapping = (theme: Theme) => ({ color: theme.colors.palette.green[500] });
const unhealthyColorMapping = (theme: Theme) => ({ color: theme.colors.palette.red[500] });

export function scriptToneColorMapping(tone: ScriptTone): (theme: Theme) => { color: string } {
  switch (tone) {
    case "idle":
      return idleColorMapping;
    case "running":
      return runningColorMapping;
    case "healthy":
      return healthyColorMapping;
    case "unhealthy":
      return unhealthyColorMapping;
  }
}
