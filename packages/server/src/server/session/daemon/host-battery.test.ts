import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readLinuxBattery } from "./host-battery.js";

/**
 * Real directories and real files rather than a mocked filesystem: sysfs is just files, so
 * there is nothing gained by faking it and a whole class of path bugs lost.
 */
const roots: string[] = [];

async function createSysfs(supplies: Record<string, Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-host-battery-"));
  roots.push(root);
  for (const [name, files] of Object.entries(supplies)) {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    for (const [file, contents] of Object.entries(files)) {
      await writeFile(path.join(dir, file), contents, "utf8");
    }
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("readLinuxBattery", () => {
  it("reports charge from a single battery's energy counters", async () => {
    const root = await createSysfs({
      BAT0: { energy_now: "37000000", energy_full: "100000000" },
    });
    await expect(readLinuxBattery(root)).resolves.toEqual({
      outcome: "ok",
      battery: { percent: 37 },
    });
  });

  it("reports charge from charge counters when energy counters are absent", async () => {
    const root = await createSysfs({
      BAT0: { charge_now: "2500000", charge_full: "5000000" },
    });
    await expect(readLinuxBattery(root)).resolves.toEqual({
      outcome: "ok",
      battery: { percent: 50 },
    });
  });

  it("combines multiple batteries by total charge rather than averaging percentages", async () => {
    const root = await createSysfs({
      BAT0: { energy_now: "90000000", energy_full: "100000000" },
      BAT1: { energy_now: "0", energy_full: "100000000" },
    });
    // Averaging the packs' own percentages would say 45%; by charge it is 45% too, so use
    // asymmetric capacities to tell the two rules apart.
    await expect(readLinuxBattery(root)).resolves.toEqual({
      outcome: "ok",
      battery: { percent: 45 },
    });

    const asymmetric = await createSysfs({
      BAT0: { energy_now: "90000000", energy_full: "100000000" },
      BAT1: { energy_now: "0", energy_full: "10000000" },
    });
    // By charge: 90 of 110 units = 81.8%. Averaging would have said 45%.
    const result = await readLinuxBattery(asymmetric);
    expect(result.outcome).toBe("ok");
    expect(result.outcome === "ok" && Math.round(result.battery.percent)).toBe(82);
  });

  it("falls back to the kernel's rounded capacity when no counters are exposed", async () => {
    const root = await createSysfs({ BAT0: { capacity: "64" } });
    await expect(readLinuxBattery(root)).resolves.toEqual({
      outcome: "ok",
      battery: { percent: 64 },
    });
  });

  it("ignores non-battery power supplies", async () => {
    const root = await createSysfs({
      AC: { online: "1" },
      BAT0: { energy_now: "20000000", energy_full: "100000000" },
    });
    await expect(readLinuxBattery(root)).resolves.toEqual({
      outcome: "ok",
      battery: { percent: 20 },
    });
  });

  it("ignores peripheral batteries that share the power-supply class", async () => {
    // A Logitech receiver registers its mouse as `hidpp_battery_2` right next to the laptop's
    // own pack. Averaging the two would report a charge belonging to neither device.
    const root = await createSysfs({
      BAT0: { energy_now: "90000000", energy_full: "100000000" },
      hidpp_battery_2: { capacity: "10" },
    });
    await expect(readLinuxBattery(root)).resolves.toEqual({
      outcome: "ok",
      battery: { percent: 90 },
    });
  });

  it("reports absence for a host with power supplies but no battery", async () => {
    const root = await createSysfs({ AC: { online: "1" } });
    await expect(readLinuxBattery(root)).resolves.toEqual({ outcome: "absent" });
  });

  it("reports absence when the power-supply class does not exist", async () => {
    const root = await createSysfs({});
    await expect(readLinuxBattery(path.join(root, "missing"))).resolves.toEqual({
      outcome: "absent",
    });
  });

  it("reports failure when a battery exposes nothing readable", async () => {
    const root = await createSysfs({ BAT0: { status: "Discharging" } });
    await expect(readLinuxBattery(root)).resolves.toEqual({ outcome: "failed" });
  });

  it("ignores a battery reporting a zero full-charge instead of dividing by zero", async () => {
    const root = await createSysfs({
      BAT0: { energy_now: "0", energy_full: "0" },
      BAT1: { energy_now: "50000000", energy_full: "100000000" },
    });
    await expect(readLinuxBattery(root)).resolves.toEqual({
      outcome: "ok",
      battery: { percent: 50 },
    });
  });
});
