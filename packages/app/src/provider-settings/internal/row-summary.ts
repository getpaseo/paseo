import type { ProviderInstallationRead } from "@/components/provider-installation";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import type { ProviderEntry } from "./provider-config";

/** What a provider's list row says under its name. */
export type RowSummary =
  /** Not known yet; the row holds the line's space. */
  | { kind: "pending" }
  | { kind: "ready"; version: string | null; models: number }
  | { kind: "updateAvailable"; version: string | null }
  | { kind: "updating"; target: string | null }
  /** The provider or its last update failed. A null message has no detail to show. */
  | { kind: "failing"; message: string | null }
  | { kind: "notInstalled" }
  | { kind: "disabled" };

type InstallationFacts = Pick<ProviderInstallationRead, "state" | "updates" | "action">;

/**
 * One line per provider, from the snapshot and the installation read. A running update leads
 * because the user just started it; then whatever keeps the provider from running, where a missing
 * CLI is not a fault; then the version and update state once the host has answered.
 */
export function readRowSummary(entry: ProviderEntry, facts: InstallationFacts): RowSummary {
  return readRunningUpdate(facts) ?? readBlocker(entry, facts) ?? readSettled(entry, facts);
}

function readRunningUpdate({ updates, action }: InstallationFacts): RowSummary | null {
  if (!action || !(action.starting || action.current?.operation.status === "running")) return null;
  const updateCheck = updates.status === "ready" ? updates.updateCheck : null;
  const versions = updateCheck?.status === "available" ? updateCheck.versions : undefined;
  return { kind: "updating", target: versions?.length === 1 ? versions[0] : null };
}

function readBlocker(
  entry: ProviderEntry,
  { state, action }: InstallationFacts,
): RowSummary | null {
  if (!entry.enabled) return { kind: "disabled" };
  const inspection = state.status === "ready" ? state.installation?.inspection : undefined;
  if (entry.status === "unavailable" || inspection?.status === "not_installed") {
    return { kind: "notInstalled" };
  }
  if (entry.status === "error") return { kind: "failing", message: entry.error?.trim() || null };
  const operation = action?.current?.operation;
  if (operation?.status === "failed") {
    return { kind: "failing", message: operation.message.trim() || null };
  }
  return null;
}

function readSettled(entry: ProviderEntry, { state, updates }: InstallationFacts): RowSummary {
  const models = filterSelectableModels(entry.models ?? null)?.length ?? 0;
  // The last count stays while the provider is probed again; only a first probe holds the line.
  if (state.status === "loading" || (entry.status === "loading" && models === 0)) {
    return { kind: "pending" };
  }
  const inspection = state.status === "ready" ? state.installation?.inspection : undefined;
  const version = inspection?.status === "installed" ? (inspection.version ?? null) : null;
  const updateCheck = updates.status === "ready" ? updates.updateCheck : null;
  if (updateCheck?.status === "available") return { kind: "updateAvailable", version };
  return { kind: "ready", version, models };
}

/** A provider that is not installed has nothing to switch: the picker leaves it out already. */
export function rowHasSwitch(summary: RowSummary): boolean {
  return summary.kind !== "notInstalled";
}
