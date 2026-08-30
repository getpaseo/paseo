import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { HostBattery } from "@getpaseo/protocol/messages";

/**
 * How the machine reports its own charge.
 *
 * Two probes, in order. Linux answers from sysfs — a couple of file reads, no subprocess, and
 * it is the common case for a daemon host. Everything else goes through `systeminformation`,
 * which shells out to `pmset` on macOS and WMI on Windows; the value there is not avoiding the
 * subprocess but inheriting parsers already debugged against OS versions we would otherwise
 * meet one bug report at a time.
 *
 * `null` means "this machine has no battery" and is a real answer, not a failure — see
 * `probeHostBattery` for why the caller must be able to tell the two apart.
 */

const SYSFS_POWER_SUPPLY = "/sys/class/power_supply";

export type HostBatteryProbe =
  | { outcome: "ok"; battery: HostBattery }
  | { outcome: "absent" }
  | { outcome: "failed" };

/**
 * One reading. The three outcomes are distinct on purpose: `absent` is durable (a desktop does
 * not grow a battery, so the sampler may stop asking), while `failed` is transient and must be
 * retried. Windows conflates them — WMI can return nothing because the host has no battery or
 * because the query needed elevation — so `readWindowsBattery` reports `failed` for the empty
 * case and lets the sampler's retry decide.
 */
export async function probeHostBattery(): Promise<HostBatteryProbe> {
  if (process.platform === "linux") {
    return await readLinuxBattery();
  }
  return await readSystemInformationBattery();
}

/**
 * Exported with the sysfs root as a parameter so tests can point it at a real directory tree
 * rather than mocking the filesystem — the multi-battery arithmetic below is the part worth
 * testing, and it only means anything against real files.
 */
export async function readLinuxBattery(
  root: string = SYSFS_POWER_SUPPLY,
): Promise<HostBatteryProbe> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    // No sysfs power-supply class at all: a container, or a kernel built without it. Nothing
    // here will ever succeed, so report absence rather than retrying forever.
    return { outcome: "absent" };
  }

  // `BAT*` is the kernel's naming for the machine's own packs. The filter matters more than it
  // looks: this class also carries peripherals — a wireless mouse shows up as `hidpp_battery_2`
  // — and folding a mouse at 10% into a laptop at 90% would report a charge nobody has.
  const batteries = entries.filter((entry) => entry.startsWith("BAT")).sort();
  if (batteries.length === 0) {
    return { outcome: "absent" };
  }

  // Multiple batteries are one power source to the user, so combine by charge rather than
  // averaging the per-pack percentages — an empty auxiliary pack alongside a full main one is
  // not "50%". Packs report either energy (µWh) or charge (µAh); a machine uses one or the
  // other, so summing within a unit is safe and mixing units cannot happen.
  let now = 0;
  let full = 0;
  for (const battery of batteries) {
    const dir = path.join(root, battery);
    const pair =
      (await readNumberPair(dir, "energy_now", "energy_full")) ??
      (await readNumberPair(dir, "charge_now", "charge_full"));
    if (pair) {
      now += pair.now;
      full += pair.full;
    }
  }
  if (full > 0) {
    return { outcome: "ok", battery: { percent: (now / full) * 100 } };
  }

  // Some packs expose only the kernel's own rounded `capacity`. With one battery that is the
  // answer; with several there is no way to weight them, so the first is the best guess.
  const capacity = await readNumber(path.join(root, batteries[0]), "capacity");
  if (capacity !== null) {
    return { outcome: "ok", battery: { percent: capacity } };
  }
  return { outcome: "failed" };
}

async function readSystemInformationBattery(): Promise<HostBatteryProbe> {
  try {
    // Imported lazily so a Linux daemon never pays to load it, and so a throw from the
    // module's own platform probing cannot take down daemon startup.
    const { battery } = await import("systeminformation");
    const reading = await battery();
    if (!reading.hasBattery) {
      // On Windows this is ambiguous — WMI reports nothing both for a desktop and for a query
      // that needed elevation — so it is a failure to retry, not a settled absence.
      return process.platform === "win32" ? { outcome: "failed" } : { outcome: "absent" };
    }
    if (typeof reading.percent !== "number" || !Number.isFinite(reading.percent)) {
      return { outcome: "failed" };
    }
    return { outcome: "ok", battery: { percent: reading.percent } };
  } catch {
    return { outcome: "failed" };
  }
}

async function readNumberPair(
  dir: string,
  nowFile: string,
  fullFile: string,
): Promise<{ now: number; full: number } | null> {
  const now = await readNumber(dir, nowFile);
  const full = await readNumber(dir, fullFile);
  if (now === null || full === null || full <= 0) {
    return null;
  }
  return { now, full };
}

async function readNumber(dir: string, file: string): Promise<number | null> {
  try {
    const raw = await readFile(path.join(dir, file), "utf8");
    const value = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
